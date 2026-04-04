import { Hono } from 'hono';
import { users, userResults, pulseData, teams, contactInquiries } from '../../shared/schema.js';
import { count, sql, desc, gte } from 'drizzle-orm';
import { getDb } from '../db.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import type { Env } from '../types.js';

const app = new Hono<{ Bindings: Env }>();

const investorLimiter = createRateLimiter(15 * 60 * 1000, 30);

app.get('/stats', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (!investorLimiter(ip)) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  try {
    const db = getDb(c.env);
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [totalUsers] = await db.select({ count: count() }).from(users);
    const [totalAssessments] = await db.select({ count: count() }).from(userResults);
    const [recentUsers] = await db.select({ count: count() }).from(users).where(gte(users.createdAt, thirtyDaysAgo));
    const [weeklyAssessments] = await db.select({ count: count() }).from(userResults).where(gte(userResults.completedAt, sevenDaysAgo));
    const [monthlyAssessments] = await db.select({ count: count() }).from(userResults).where(gte(userResults.completedAt, thirtyDaysAgo));
    const [previousMonthAssessments] = await db.select({ count: count() }).from(userResults).where(sql`${userResults.completedAt} >= ${sixtyDaysAgo} AND ${userResults.completedAt} < ${thirtyDaysAgo}`);

    const returningUsers = await db.execute(sql`
      SELECT COUNT(*) as count FROM (
        SELECT user_id FROM user_results
        GROUP BY user_id
        HAVING COUNT(*) > 1
      ) returning_users
    `);
    const returningCount = Number(returningUsers.rows?.[0]?.count ?? 0);

    const retentionRate = totalUsers.count > 0
      ? Number(((returningCount / totalUsers.count) * 100).toFixed(1))
      : 0;

    const pulseRecords = await db.select().from(pulseData).orderBy(desc(pulseData.updatedAt)).limit(12);
    const totalDataPoints = pulseRecords.reduce((sum, p) => sum + p.sampleCount, 0) * 17;

    const [totalTeams] = await db.select({ count: count() }).from(teams);
    const [totalInquiries] = await db.select({ count: count() }).from(contactInquiries);

    const growthRate = previousMonthAssessments.count > 0
      ? Number((((monthlyAssessments.count - previousMonthAssessments.count) / previousMonthAssessments.count) * 100).toFixed(1))
      : monthlyAssessments.count > 0 ? 100 : 0;

    const viralCoefficient = totalUsers.count > 0
      ? Number((recentUsers.count / Math.max(totalUsers.count - recentUsers.count, 1)).toFixed(2))
      : 0;

    return c.json({
      platform: 'FLUX-DNA',
      generatedAt: now.toISOString(),
      growth: {
        totalUsers: totalUsers.count,
        totalAssessments: totalAssessments.count,
        newUsersLast30Days: recentUsers.count,
        weeklyAssessments: weeklyAssessments.count,
        monthlyAssessments: monthlyAssessments.count,
        monthOverMonthGrowth: growthRate,
      },
      retention: {
        returningUsers: returningCount,
        retentionRate,
        avgAssessmentsPerUser: totalUsers.count > 0 ? Number((totalAssessments.count / totalUsers.count).toFixed(2)) : 0,
      },
      viralMetrics: {
        viralCoefficient,
        organicGrowthRate: growthRate,
      },
      dataDepth: {
        totalAnonymizedDataPoints: totalDataPoints,
        periodsTracked: pulseRecords.length,
        assessmentInstruments: 3,
        questionsPerAssessment: 111,
        dimensionsMeasured: 17,
      },
      b2b: {
        totalTeams: totalTeams.count,
        businessInquiries: totalInquiries.count,
      },
      security: {
        encryptionStandard: 'AES-256-GCM',
        keyDerivation: 'PBKDF2 (100k iterations)',
        dataPolicy: 'Zero-knowledge architecture',
      },
    });
  } catch (error) {
    console.error('Investor stats error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to generate investor stats' }, 500);
  }
});

export default app;
