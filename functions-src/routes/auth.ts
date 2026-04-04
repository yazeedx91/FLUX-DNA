import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Env } from '../types.js';
import { getDb } from '../db.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { generateToken } from '../lib/encryption.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { sendMagicLinkEmail } from '../lib/mailer.js';
import { users, userResults, teams } from '../../shared/schema.js';
import { magicLinkRequestSchema, validateRequest } from '../lib/validation.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const verifyTokenSchema = z.object({
  token: z.string().length(64, 'Invalid token format'),
});

// ── Backoff store (module-level, per-isolate) ────────────────────────────────

const backoffStore = new Map<string, { level: number; lastViolation: number }>();
let lastCleanup = Date.now();

const getBackoffMinutes = (level: number): number => {
  const minutes = [15, 30, 60, 120];
  return minutes[Math.min(level - 1, minutes.length - 1)];
};

function cleanupBackoffStore() {
  const now = Date.now();
  if (now - lastCleanup < 300000) return;
  lastCleanup = now;
  for (const [key, value] of backoffStore.entries()) {
    if (now - value.lastViolation > 7200000) {
      backoffStore.delete(key);
    }
  }
}

// ── Rate limiters ────────────────────────────────────────────────────────────

const magicLinkLimiter = createRateLimiter(15 * 60 * 1000, 5);
const verifyLimiter = createRateLimiter(5 * 60 * 1000, 10);
const generalLimiter = createRateLimiter(60 * 1000, 60);

function resolveIp(req: { header: (name: string) => string | undefined }): string {
  return req.header('cf-connecting-ip') ?? req.header('x-forwarded-for') ?? 'unknown';
}

function applyBackoff(key: string): { waitMinutes: number; level: number } {
  cleanupBackoffStore();
  const now = Date.now();
  let entry = backoffStore.get(key);
  if (!entry) {
    entry = { level: 1, lastViolation: now };
    backoffStore.set(key, entry);
  } else {
    if (now - entry.lastViolation < 3600000) {
      entry.level = Math.min(entry.level + 1, 4);
    }
    entry.lastViolation = now;
    backoffStore.set(key, entry);
  }
  return { waitMinutes: getBackoffMinutes(entry.level), level: entry.level };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/request-magic-link', async (c) => {
  const ip = resolveIp(c.req);
  if (!magicLinkLimiter(ip)) {
    const { waitMinutes, level } = applyBackoff(ip);
    return c.json(
      { error: `Rate limit exceeded. Please wait ${waitMinutes} minutes before trying again.`, retryAfter: waitMinutes * 60, backoffLevel: level },
      429
    );
  }

  try {
    const body = await c.req.json();
    const validation = validateRequest(magicLinkRequestSchema, body);
    if (!validation.success) {
      return c.json({ error: validation.error }, 400);
    }

    const { email } = validation.data;
    const normalizedEmail = email.toLowerCase().trim().replace(/[<>'"\\;]/g, '');

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const db = getDb(c.env);
    const [existingUser] = await db.select().from(users).where(eq(users.email, normalizedEmail));

    if (existingUser) {
      await db.update(users)
        .set({ magicLinkToken: token, magicLinkExpiresAt: expiresAt })
        .where(eq(users.email, normalizedEmail));
    } else {
      await db.insert(users).values({
        email: normalizedEmail,
        magicLinkToken: token,
        magicLinkExpiresAt: expiresAt,
      });
    }

    const baseUrl = `https://${c.env.APP_DOMAIN}`;
    const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

    await sendMagicLinkEmail(normalizedEmail, magicLink, c.env);

    return c.json({ success: true, message: 'If this email exists, a magic link has been sent.' });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error sending magic link:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to process request' }, 500);
  }
});

app.get('/verify', async (c) => {
  const ip = resolveIp(c.req);
  if (!verifyLimiter(ip)) {
    const { waitMinutes, level } = applyBackoff(ip);
    return c.json(
      { error: `Rate limit exceeded. Please wait ${waitMinutes} minutes before trying again.`, retryAfter: waitMinutes * 60, backoffLevel: level },
      429
    );
  }

  try {
    const queryValidation = verifyTokenSchema.safeParse({ token: c.req.query('token') });
    if (!queryValidation.success) {
      return c.json({ error: 'Invalid token format' }, 400);
    }
    const { token } = queryValidation.data;

    const db = getDb(c.env);
    const [user] = await db.select().from(users).where(eq(users.magicLinkToken, token));

    if (!user) {
      return c.redirect('/login?expired=true');
    }

    if (user.magicLinkExpiresAt && new Date() > user.magicLinkExpiresAt) {
      await db.update(users)
        .set({ magicLinkToken: null, magicLinkExpiresAt: null })
        .where(eq(users.id, user.id));
      return c.redirect('/login?expired=true');
    }

    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.update(users)
      .set({
        magicLinkToken: null,
        magicLinkExpiresAt: null,
        sessionToken,
        sessionExpiresAt,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, user.id));

    setCookie(c, 'session', sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 86400,
    });

    const existingResults = await db.select({ id: userResults.id })
      .from(userResults)
      .where(eq(userResults.userId, user.id))
      .limit(1);

    if (existingResults.length > 0) {
      return c.redirect('/results?authenticated=true');
    } else {
      return c.redirect('/?authenticated=true');
    }
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error verifying magic link:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to verify token' }, 500);
  }
});

app.get('/me', requireAuth, async (c) => {
  const ip = resolveIp(c.req);
  if (!generalLimiter(ip)) {
    const { waitMinutes, level } = applyBackoff(ip);
    return c.json(
      { error: `Rate limit exceeded. Please wait ${waitMinutes} minutes before trying again.`, retryAfter: waitMinutes * 60, backoffLevel: level },
      429
    );
  }

  try {
    return c.json({ user: c.get('user') });
  } catch (error) {
    return c.json({ error: 'Failed to get user info' }, 500);
  }
});

app.post('/logout', requireAuth, async (c) => {
  const ip = resolveIp(c.req);
  if (!generalLimiter(ip)) {
    const { waitMinutes, level } = applyBackoff(ip);
    return c.json(
      { error: `Rate limit exceeded. Please wait ${waitMinutes} minutes before trying again.`, retryAfter: waitMinutes * 60, backoffLevel: level },
      429
    );
  }

  try {
    const user = c.get('user');
    if (user) {
      const db = getDb(c.env);
      await db.update(users)
        .set({ sessionToken: null, sessionExpiresAt: null })
        .where(eq(users.id, user.id));
    }
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ success: true });
  } catch (error) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ success: true });
  }
});

app.delete('/account', requireAuth, async (c) => {
  const ip = resolveIp(c.req);
  if (!generalLimiter(ip)) {
    const { waitMinutes, level } = applyBackoff(ip);
    return c.json(
      { error: `Rate limit exceeded. Please wait ${waitMinutes} minutes before trying again.`, retryAfter: waitMinutes * 60, backoffLevel: level },
      429
    );
  }

  try {
    const user = c.get('user');
    const userId = user!.id;
    const db = getDb(c.env);
    await db.delete(teams).where(eq(teams.leaderUserId, userId));
    await db.delete(users).where(eq(users.id, userId));
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ success: true, message: 'Account and all associated data have been permanently deleted.' });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error deleting account:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to delete account' }, 500);
  }
});

export default app;
