import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, count, sql, inArray } from 'drizzle-orm';
import type { Env } from '../types.js';
import { getDb } from '../db.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { decrypt } from '../lib/encryption.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { teams, userResults } from '../../shared/schema.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ── Rate limiter ─────────────────────────────────────────────────────────────

const checkTeamLimit = createRateLimiter(15 * 60 * 1000, 20);

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

function generateTeamCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return 'FX-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const createTeamSchema = z.object({
  name: z.string().min(2, 'Team name must be at least 2 characters').max(100, 'Team name too long').transform(stripHtml),
  description: z.string().max(500).optional().transform(val => val ? stripHtml(val) : val),
});

const teamCodeParamSchema = z.object({
  code: z.string().regex(/^FX-[A-Z0-9]{8}$/, 'Invalid team code format'),
});

// ── POST /create ─────────────────────────────────────────────────────────────

app.post('/create', requireAuth, async (c) => {
  const user = c.get('user');
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';

  if (!checkTeamLimit(ip)) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  try {
    const body = await c.req.json();
    const validation = createTeamSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: validation.error.errors[0].message }, 400);
    }

    const { name, description } = validation.data;
    const code = generateTeamCode();
    const db = getDb(c.env);

    const [team] = await db.insert(teams).values({
      code,
      name,
      leaderUserId: user.id,
      description: description || null,
    }).returning();

    return c.json({ success: true, team: { id: team.id, code: team.code, name: team.name } });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Team create error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to create team' }, 500);
  }
});

// ── GET /my-teams ─────────────────────────────────────────────────────────────

app.get('/my-teams', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    const userId = user.id;
    const db = getDb(c.env);

    const ledTeams = await db.select().from(teams).where(eq(teams.leaderUserId, userId));

    const memberTeamCodes = await db.selectDistinct({ teamCode: userResults.teamCode })
      .from(userResults)
      .where(and(eq(userResults.userId, userId), sql`${userResults.teamCode} IS NOT NULL`));

    const memberCodes = memberTeamCodes.map(r => r.teamCode).filter(Boolean) as string[];
    let memberTeams: typeof ledTeams = [];
    if (memberCodes.length > 0) {
      memberTeams = await db.select().from(teams).where(inArray(teams.code, memberCodes));
    }

    const allTeams = [...ledTeams, ...memberTeams.filter(t => !ledTeams.some(lt => lt.id === t.id))];

    const teamsWithCounts = await Promise.all(allTeams.map(async (team) => {
      const [memberCount] = await db.select({ count: count() })
        .from(userResults)
        .where(sql`${userResults.teamCode} = ${team.code}`);

      const uniqueMembers = await db.selectDistinct({ userId: userResults.userId })
        .from(userResults)
        .where(sql`${userResults.teamCode} = ${team.code}`);

      return {
        ...team,
        memberCount: uniqueMembers.length,
        assessmentCount: memberCount.count,
        isLeader: team.leaderUserId === userId,
      };
    }));

    return c.json({ teams: teamsWithCounts });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('My teams error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to fetch teams' }, 500);
  }
});

// ── GET /report/:code ─────────────────────────────────────────────────────────

app.get('/report/:code', requireAuth, async (c) => {
  try {
    const paramValidation = teamCodeParamSchema.safeParse(c.req.param());
    if (!paramValidation.success) {
      return c.json({ error: 'Invalid team code format' }, 400);
    }
    const { code } = paramValidation.data;
    const db = getDb(c.env);

    const [team] = await db.select().from(teams).where(sql`${teams.code} = ${code}`);
    if (!team) {
      return c.json({ error: 'Team not found' }, 404);
    }

    const teamResults = await db.select({
      id: userResults.id,
      userId: userResults.userId,
      dassDepressionEncrypted: userResults.dassDepressionEncrypted,
      dassAnxietyEncrypted: userResults.dassAnxietyEncrypted,
      dassStressEncrypted: userResults.dassStressEncrypted,
      hexacoScores: userResults.hexacoScores,
      completedAt: userResults.completedAt,
    }).from(userResults).where(sql`${userResults.teamCode} = ${code}`);

    const uniqueUserIds = [...new Set(teamResults.map(r => r.userId))];

    if (uniqueUserIds.length < 5) {
      return c.json({
        team: { name: team.name, code: team.code },
        ready: false,
        currentMembers: uniqueUserIds.length,
        requiredMembers: 5,
        message: `${5 - uniqueUserIds.length} more team member(s) needed to unlock the Team Dynamic Range report.`,
      });
    }

    const aggregated = {
      depression: { sum: 0, count: 0 },
      anxiety: { sum: 0, count: 0 },
      stress: { sum: 0, count: 0 },
      hexaco: {
        HonestyHumility: { sum: 0, count: 0 },
        Emotionality: { sum: 0, count: 0 },
        Extraversion: { sum: 0, count: 0 },
        Agreeableness: { sum: 0, count: 0 },
        Conscientiousness: { sum: 0, count: 0 },
        OpennessToExperience: { sum: 0, count: 0 },
      },
    };

    for (const result of teamResults) {
      try {
        const dep = parseInt(await decrypt(result.dassDepressionEncrypted, result.userId, c.env.ENCRYPTION_KEY));
        const anx = parseInt(await decrypt(result.dassAnxietyEncrypted, result.userId, c.env.ENCRYPTION_KEY));
        const str = parseInt(await decrypt(result.dassStressEncrypted, result.userId, c.env.ENCRYPTION_KEY));
        aggregated.depression.sum += dep;
        aggregated.depression.count++;
        aggregated.anxiety.sum += anx;
        aggregated.anxiety.count++;
        aggregated.stress.sum += str;
        aggregated.stress.count++;

        if (result.hexacoScores) {
          try {
            const hexaco = JSON.parse(await decrypt(result.hexacoScores, result.userId, c.env.ENCRYPTION_KEY));
            for (const key of Object.keys(aggregated.hexaco) as (keyof typeof aggregated.hexaco)[]) {
              if (hexaco[key] != null) {
                aggregated.hexaco[key].sum += hexaco[key];
                aggregated.hexaco[key].count++;
              }
            }
          } catch {}
        }
      } catch {}
    }

    const avg = (obj: { sum: number; count: number }) =>
      obj.count > 0 ? Number((obj.sum / obj.count).toFixed(2)) : 0;

    const teamProfile = {
      dassAverages: {
        Depression: avg(aggregated.depression),
        Anxiety: avg(aggregated.anxiety),
        Stress: avg(aggregated.stress),
      },
      hexacoAverages: {
        HonestyHumility: avg(aggregated.hexaco.HonestyHumility),
        Emotionality: avg(aggregated.hexaco.Emotionality),
        Extraversion: avg(aggregated.hexaco.Extraversion),
        Agreeableness: avg(aggregated.hexaco.Agreeableness),
        Conscientiousness: avg(aggregated.hexaco.Conscientiousness),
        OpennessToExperience: avg(aggregated.hexaco.OpennessToExperience),
      },
    };

    const hexacoValues = Object.values(teamProfile.hexacoAverages);
    const maxTrait = Object.keys(teamProfile.hexacoAverages)[hexacoValues.indexOf(Math.max(...hexacoValues))];
    const minTrait = Object.keys(teamProfile.hexacoAverages)[hexacoValues.indexOf(Math.min(...hexacoValues))];

    const dynamicRange = Math.max(...hexacoValues) - Math.min(...hexacoValues);
    const cohesionScore = Number((100 - (dynamicRange / 4) * 100).toFixed(1));

    return c.json({
      team: { name: team.name, code: team.code },
      ready: true,
      memberCount: uniqueUserIds.length,
      assessmentCount: teamResults.length,
      teamProfile,
      insights: {
        dominantTrait: maxTrait,
        developmentArea: minTrait,
        dynamicRange: Number(dynamicRange.toFixed(2)),
        cohesionScore,
        stressResilience: Number(((1 - teamProfile.dassAverages.Stress / 42) * 100).toFixed(1)),
        emotionalBalance: Number(((1 - teamProfile.dassAverages.Anxiety / 42) * 100).toFixed(1)),
      },
    });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Team report error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to generate team report' }, 500);
  }
});

// ── GET /validate/:code ───────────────────────────────────────────────────────

app.get('/validate/:code', async (c) => {
  try {
    const paramValidation = teamCodeParamSchema.safeParse(c.req.param());
    if (!paramValidation.success) {
      return c.json({ error: 'Invalid team code format' }, 400);
    }
    const { code } = paramValidation.data;
    const db = getDb(c.env);

    const [team] = await db.select({ name: teams.name, code: teams.code })
      .from(teams)
      .where(sql`${teams.code} = ${code}`);

    if (!team) {
      return c.json({ error: 'Invalid team code' }, 404);
    }

    return c.json({ valid: true, teamName: team.name });
  } catch (error) {
    return c.json({ error: 'Failed to validate team code' }, 500);
  }
});

export default app;
