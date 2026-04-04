import { Hono } from 'hono';
import { getDb } from '../db.js';
import { pulseData } from '../../shared/schema.js';
import { eq, desc } from 'drizzle-orm';
import type { Env } from '../types.js';
import type { AuthVariables } from '../middleware/auth.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function getCurrentPeriodKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-W${String(Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7)).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export async function recordPulseData(
  scores: {
    dassScores: { Depression: number; Anxiety: number; Stress: number };
    hexacoScores: { HonestyHumility: number; Emotionality: number; Extraversion: number; Agreeableness: number; Conscientiousness: number; OpennessToExperience: number };
    teiqueScores?: { Wellbeing: number; SelfControl: number; Emotionality: number; Sociability: number; GlobalEI: number } | null;
  },
  env: Env
): Promise<void> {
  try {
    const db = getDb(env);
    const periodKey = getCurrentPeriodKey();
    const existing = await db.select().from(pulseData).where(eq(pulseData.periodKey, periodKey)).limit(1);

    if (existing.length > 0) {
      const row = existing[0];
      const n = row.sampleCount;
      const newN = n + 1;
      await db.update(pulseData).set({
        avgDepression: (row.avgDepression * n + scores.dassScores.Depression) / newN,
        avgAnxiety: (row.avgAnxiety * n + scores.dassScores.Anxiety) / newN,
        avgStress: (row.avgStress * n + scores.dassScores.Stress) / newN,
        avgHonestyHumility: (row.avgHonestyHumility * n + scores.hexacoScores.HonestyHumility) / newN,
        avgEmotionality: (row.avgEmotionality * n + scores.hexacoScores.Emotionality) / newN,
        avgExtraversion: (row.avgExtraversion * n + scores.hexacoScores.Extraversion) / newN,
        avgAgreeableness: (row.avgAgreeableness * n + scores.hexacoScores.Agreeableness) / newN,
        avgConscientiousness: (row.avgConscientiousness * n + scores.hexacoScores.Conscientiousness) / newN,
        avgOpenness: (row.avgOpenness * n + scores.hexacoScores.OpennessToExperience) / newN,
        avgWellbeing: scores.teiqueScores ? (row.avgWellbeing * n + scores.teiqueScores.Wellbeing) / newN : row.avgWellbeing,
        avgSelfControl: scores.teiqueScores ? (row.avgSelfControl * n + scores.teiqueScores.SelfControl) / newN : row.avgSelfControl,
        avgEISociability: scores.teiqueScores ? (row.avgEISociability * n + scores.teiqueScores.Sociability) / newN : row.avgEISociability,
        avgGlobalEI: scores.teiqueScores ? (row.avgGlobalEI * n + scores.teiqueScores.GlobalEI) / newN : row.avgGlobalEI,
        sampleCount: newN,
        updatedAt: new Date(),
      }).where(eq(pulseData.id, row.id));
    } else {
      await db.insert(pulseData).values({
        periodKey,
        avgDepression: scores.dassScores.Depression,
        avgAnxiety: scores.dassScores.Anxiety,
        avgStress: scores.dassScores.Stress,
        avgHonestyHumility: scores.hexacoScores.HonestyHumility,
        avgEmotionality: scores.hexacoScores.Emotionality,
        avgExtraversion: scores.hexacoScores.Extraversion,
        avgAgreeableness: scores.hexacoScores.Agreeableness,
        avgConscientiousness: scores.hexacoScores.Conscientiousness,
        avgOpenness: scores.hexacoScores.OpennessToExperience,
        avgWellbeing: scores.teiqueScores?.Wellbeing ?? 0,
        avgSelfControl: scores.teiqueScores?.SelfControl ?? 0,
        avgEISociability: scores.teiqueScores?.Sociability ?? 0,
        avgGlobalEI: scores.teiqueScores?.GlobalEI ?? 0,
        sampleCount: 1,
      });
    }
  } catch (error) {
    if (env.NODE_ENV !== 'production') console.error('Pulse data recording error:', error instanceof Error ? error.message : 'Unknown');
  }
}

app.get('/global', async (c) => {
  try {
    const db = getDb(c.env);
    const periods = await db.select()
      .from(pulseData)
      .orderBy(desc(pulseData.updatedAt))
      .limit(12);

    const totalSamples = periods.reduce((sum, p) => sum + p.sampleCount, 0);
    const latest = periods[0];

    return c.json({
      totalDataPoints: totalSamples,
      periodsTracked: periods.length,
      currentPulse: latest ? {
        creativity: Number(((latest.avgOpenness / 5) * 100).toFixed(1)),
        resilience: Number(((1 - latest.avgStress / 42) * 100).toFixed(1)),
        emotionalIntelligence: Number(((latest.avgGlobalEI / 7) * 100).toFixed(1)),
        socialDynamism: Number(((latest.avgExtraversion / 5) * 100).toFixed(1)),
        riskTolerance: Number(((1 - latest.avgHonestyHumility / 5) * 100).toFixed(1)),
        wellbeing: Number(((latest.avgWellbeing / 7) * 100).toFixed(1)),
        sampleSize: latest.sampleCount,
        period: latest.periodKey,
      } : null,
      trends: periods.map(p => ({
        period: p.periodKey,
        sampleCount: p.sampleCount,
        avgCreativity: Number(((p.avgOpenness / 5) * 100).toFixed(1)),
        avgResilience: Number(((1 - p.avgStress / 42) * 100).toFixed(1)),
        avgEI: Number(((p.avgGlobalEI / 7) * 100).toFixed(1)),
      })),
    });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Pulse global error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to fetch pulse data' }, 500);
  }
});

export default app;
