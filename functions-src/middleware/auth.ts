import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db.js';
import { users } from '../../shared/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import type { Env } from '../types.js';

export type AuthUser = { id: number; email: string };

export type AuthVariables = { user: AuthUser };

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const sessionToken = getCookie(c, 'session');

    if (!sessionToken) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const db = getDb(c.env);
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.sessionToken, sessionToken), gt(users.sessionExpiresAt, new Date())));

    if (!user) {
      return c.json({ error: 'Invalid or expired session' }, 401);
    }

    c.set('user', { id: user.id, email: user.email });
    await next();
  }
);

export const optionalAuth = createMiddleware<{ Bindings: Env; Variables: Partial<AuthVariables> }>(
  async (c, next) => {
    const sessionToken = getCookie(c, 'session');

    if (sessionToken) {
      try {
        const db = getDb(c.env);
        const [user] = await db
          .select()
          .from(users)
          .where(and(eq(users.sessionToken, sessionToken), gt(users.sessionExpiresAt, new Date())));

        if (user) {
          c.set('user', { id: user.id, email: user.email });
        }
      } catch {
        // Ignore errors in optional auth
      }
    }

    await next();
  }
);
