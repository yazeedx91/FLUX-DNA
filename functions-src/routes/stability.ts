import { Hono } from 'hono';
import OpenAI from 'openai';
import { getDb } from '../db.js';
import { users, userResults } from '../../shared/schema.js';
import { eq, desc } from 'drizzle-orm';
import { encrypt, decrypt, generateToken } from '../lib/encryption.js';
import { requireAuth } from '../middleware/auth.js';
import { analyzeRequestSchema, submitRequestSchema, validateRequest } from '../lib/validation.js';
import { recordPulseData } from './pulse.js';
import { sendResultsEmail, sendMagicLinkEmail, sendFounderAlert } from '../lib/mailer.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import type { Env } from '../types.js';
import type { AuthVariables } from '../middleware/auth.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const VALID_STABILITY_VALUES = ['Stable', 'At Risk', 'Critical'] as const;

function findAnalysisObject(obj: any, depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  if (obj.overallStability !== undefined || obj.overall_stability !== undefined ||
      obj.stabilityScore !== undefined || obj.stability_score !== undefined) return obj;
  for (const key of ['analysis', 'stabilityAnalysis', 'stability_analysis', 'result', 'data', 'response']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = findAnalysisObject(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function safeDassTotal(dassScores?: { Depression: number; Anxiety: number; Stress: number }): number {
  if (!dassScores) return 0;
  const d = Number(dassScores.Depression) || 0;
  const a = Number(dassScores.Anxiety) || 0;
  const s = Number(dassScores.Stress) || 0;
  return d + a + s;
}

function normalizeOverallStability(value: any, dassTotal: number): 'Stable' | 'At Risk' | 'Critical' {
  if (typeof value === 'string') {
    const lower = value.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (lower === 'stable') return 'Stable';
    if (lower === 'at risk' || lower === 'atrisk') return 'At Risk';
    if (lower === 'critical') return 'Critical';
  }
  return dassTotal >= 60 ? 'Critical' : dassTotal >= 30 ? 'At Risk' : 'Stable';
}

function extractField(source: any, camel: string, snake: string): any {
  return source[camel] !== undefined ? source[camel] : source[snake];
}

function normalizeStabilityAnalysis(raw: any, dassScores?: { Depression: number; Anxiety: number; Stress: number }): any {
  if (!raw || typeof raw !== 'object') {
    return buildFallbackAnalysis(dassScores);
  }

  const source = findAnalysisObject(raw) || raw;
  const dassTotal = safeDassTotal(dassScores);

  const scoreRaw = Number(extractField(source, 'stabilityScore', 'stability_score'));
  let stabilityScore = (!isNaN(scoreRaw) && scoreRaw >= 0 && scoreRaw <= 100)
    ? Math.round(scoreRaw)
    : Math.max(0, Math.min(100, 100 - Math.round(dassTotal * 0.8)));

  if (stabilityScore === 0 && dassTotal < 126) {
    stabilityScore = Math.max(1, Math.min(100, 100 - Math.round(dassTotal * 0.8)));
  }

  const rawOverall = extractField(source, 'overallStability', 'overall_stability');
  const rawSummary = extractField(source, 'summary', 'summary');
  const rawPMI = extractField(source, 'personalityMoodInteraction', 'personality_mood_interaction');
  const rawEII = extractField(source, 'emotionalIntelligenceInsights', 'emotional_intelligence_insights');
  const rawRecs = extractField(source, 'recommendations', 'recommendations');
  const rawNotes = extractField(source, 'clinicalNotes', 'clinical_notes');
  const rawFlags = extractField(source, 'riskFlags', 'risk_flags');

  return {
    overallStability: normalizeOverallStability(rawOverall, dassTotal),
    stabilityScore,
    summary: (typeof rawSummary === 'string' && rawSummary.length > 0)
      ? rawSummary
      : 'Analysis complete. Review your scores below for detailed insights.',
    personalityMoodInteraction: (typeof rawPMI === 'string')
      ? rawPMI
      : '',
    emotionalIntelligenceInsights: (typeof rawEII === 'string')
      ? rawEII
      : '',
    recommendations: Array.isArray(rawRecs)
      ? rawRecs.filter((r: any) => typeof r === 'string')
      : ['Continue monitoring your wellbeing patterns over time.'],
    clinicalNotes: (typeof rawNotes === 'string')
      ? rawNotes
      : '',
    riskFlags: (rawFlags && typeof rawFlags === 'object')
      ? rawFlags
      : {
          acuteReactiveState: false,
          highFunctioningBurnout: false,
          emotionalDysregulation: false,
          elevatedDepression: dassScores ? (Number(dassScores.Depression) || 0) >= 14 : false,
          elevatedAnxiety: dassScores ? (Number(dassScores.Anxiety) || 0) >= 10 : false,
          elevatedStress: dassScores ? (Number(dassScores.Stress) || 0) >= 19 : false,
        },
  };
}

function buildFallbackAnalysis(dassScores?: { Depression: number; Anxiety: number; Stress: number }): any {
  const total = safeDassTotal(dassScores);
  const d = dassScores ? (Number(dassScores.Depression) || 0) : 0;
  const a = dassScores ? (Number(dassScores.Anxiety) || 0) : 0;
  const s = dassScores ? (Number(dassScores.Stress) || 0) : 0;
  return {
    overallStability: total >= 60 ? 'Critical' : total >= 30 ? 'At Risk' : 'Stable',
    stabilityScore: Math.max(0, Math.min(100, 100 - Math.round(total * 0.8))),
    riskFlags: {
      acuteReactiveState: false,
      highFunctioningBurnout: false,
      emotionalDysregulation: false,
      elevatedDepression: d >= 14,
      elevatedAnxiety: a >= 10,
      elevatedStress: s >= 19,
    },
    personalityMoodInteraction: 'Analysis based on psychometric score ranges.',
    emotionalIntelligenceInsights: '',
    recommendations: ['Continue monitoring your wellbeing patterns over time.'],
    clinicalNotes: '',
    summary: 'Analysis complete. Review your scores below for detailed insights.',
  };
}

// ── Rate limiters ────────────────────────────────────────────────────────────

const questionsLimiter = createRateLimiter(15 * 60 * 1000, 60);
const analyzeLimiter = createRateLimiter(60 * 60 * 1000, 5);
const submitLimiter = createRateLimiter(60 * 60 * 1000, 5);

function resolveIp(req: { header: (name: string) => string | undefined }): string {
  return req.header('cf-connecting-ip') ?? req.header('x-forwarded-for') ?? 'unknown';
}

// ── In-memory question bank cache (per-isolate) ──────────────────────────────

let questionBankCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/questions', async (c) => {
  const ip = resolveIp(c.req);
  if (!questionsLimiter(ip)) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  try {
    if (questionBankCache && Date.now() - questionBankCache.timestamp < CACHE_TTL) {
      c.header('X-Cache', 'HIT');
      return c.json(questionBankCache.data);
    }

    const { HEXACO_ITEMS, DASS_ITEMS, TEIQUE_ITEMS } = await import('../../src/algorithms/ScoringAlgorithm.js');

    const questions = {
      hexaco: HEXACO_ITEMS.map((item: any) => ({
        id: item.id,
        facet: item.facet,
        text: item.text,
        category: item.category,
      })),
      dass: DASS_ITEMS.map((item: any) => ({
        id: item.id,
        scale: item.scale,
        text: item.text,
        category: item.category,
      })),
      teique: TEIQUE_ITEMS.map((item: any) => ({
        id: item.id,
        factor: item.factor,
        text: item.text,
        category: item.category,
      })),
      metadata: {
        hexacoCount: HEXACO_ITEMS.length,
        dassCount: DASS_ITEMS.length,
        teiqueCount: TEIQUE_ITEMS.length,
        totalCount: HEXACO_ITEMS.length + DASS_ITEMS.length + TEIQUE_ITEMS.length,
      },
    };

    questionBankCache = { data: questions, timestamp: Date.now() };
    c.header('X-Cache', 'MISS');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(questions);
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error fetching questions:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to fetch question bank' }, 500);
  }
});

app.post('/analyze', requireAuth, async (c) => {
  const ip = resolveIp(c.req);
  if (!analyzeLimiter(ip)) {
    return c.json({ error: 'Assessment submission limit reached. Please try again later.' }, 429);
  }

  try {
    const body = await c.req.json();
    const validation = validateRequest(analyzeRequestSchema, body);
    if (!validation.success) {
      return c.json({ error: `Invalid assessment data: ${validation.error}` }, 400);
    }

    const { assessmentData } = validation.data;
    const user = c.get('user');
    const userId = user!.id;
    const { dassScores, hexacoScores, teiqueScores, rawResponses } = assessmentData;

    const prompt = `You are a clinical psychologist AI assistant. Analyze the following psychometric assessment results and provide a comprehensive stability analysis.

## DASS-21 Scores (Depression, Anxiety, Stress Scale):
- Depression: ${dassScores.Depression} (Normal: 0-9, Mild: 10-13, Moderate: 14-20, Severe: 21-27, Extremely Severe: 28+)
- Anxiety: ${dassScores.Anxiety} (Normal: 0-7, Mild: 8-9, Moderate: 10-14, Severe: 15-19, Extremely Severe: 20+)
- Stress: ${dassScores.Stress} (Normal: 0-14, Mild: 15-18, Moderate: 19-25, Severe: 26-33, Extremely Severe: 34+)

## HEXACO-60 Personality Scores (1-5 scale):
- Honesty-Humility: ${hexacoScores.HonestyHumility}
- Emotionality: ${hexacoScores.Emotionality}
- Extraversion: ${hexacoScores.Extraversion}
- Agreeableness: ${hexacoScores.Agreeableness}
- Conscientiousness: ${hexacoScores.Conscientiousness}
- Openness to Experience: ${hexacoScores.OpennessToExperience}

${teiqueScores ? `## TEIQue-SF Emotional Intelligence Scores (1-7 scale):
- Well-being: ${teiqueScores.Wellbeing}
- Self-Control: ${teiqueScores.SelfControl}
- Emotionality: ${teiqueScores.Emotionality}
- Sociability: ${teiqueScores.Sociability}
- Global EI: ${teiqueScores.GlobalEI}` : ''}

Please provide:
1. **Overall Stability Assessment**: Rate as "Stable", "At Risk", or "Critical"
2. **Risk Flags**: Identify any concerning patterns (e.g., Acute Reactive State, High-Functioning Burnout, Emotional Dysregulation)
3. **Personality-Mood Interaction Analysis**: How personality traits may influence or be influenced by current mental health state
4. **Emotional Intelligence Integration**: How EI factors relate to current symptomatology
5. **Recommendations**: Evidence-based suggestions for maintaining or improving psychological wellbeing
6. **Clinical Notes**: Any observations that would be relevant for a mental health professional

Format your response as a structured JSON object with the following schema:
{
  "overallStability": "Stable" | "At Risk" | "Critical",
  "riskFlags": {
    "acuteReactiveState": boolean,
    "highFunctioningBurnout": boolean,
    "emotionalDysregulation": boolean,
    "elevatedDepression": boolean,
    "elevatedAnxiety": boolean,
    "elevatedStress": boolean
  },
  "stabilityScore": number (0-100, where 100 is most stable),
  "personalityMoodInteraction": string,
  "emotionalIntelligenceInsights": string,
  "recommendations": string[],
  "clinicalNotes": string,
  "summary": string
}`;

    const openai = new OpenAI({
      apiKey: c.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: c.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [
        {
          role: 'system',
          content: 'You are a clinical psychologist AI providing professional psychometric analysis. Always respond with valid JSON. Be thorough but compassionate in your analysis.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 2048,
    });

    const analysisContent = response.choices[0]?.message?.content || '{}';
    let stabilityAnalysis = normalizeStabilityAnalysis(JSON.parse(analysisContent), dassScores);

    if (stabilityAnalysis.stabilityScore === 0) {
      stabilityAnalysis = buildFallbackAnalysis(dassScores);
    }

    const encryptedDepression = await encrypt(String(dassScores.Depression), userId, c.env.ENCRYPTION_KEY);
    const encryptedAnxiety = await encrypt(String(dassScores.Anxiety), userId, c.env.ENCRYPTION_KEY);
    const encryptedStress = await encrypt(String(dassScores.Stress), userId, c.env.ENCRYPTION_KEY);
    const encryptedHexaco = await encrypt(JSON.stringify(hexacoScores), userId, c.env.ENCRYPTION_KEY);
    const encryptedTeique = teiqueScores ? await encrypt(JSON.stringify(teiqueScores), userId, c.env.ENCRYPTION_KEY) : null;
    const encryptedStabilityAnalysis = await encrypt(JSON.stringify(stabilityAnalysis), userId, c.env.ENCRYPTION_KEY);
    const encryptedRawResponses = rawResponses ? await encrypt(JSON.stringify(rawResponses), userId, c.env.ENCRYPTION_KEY) : null;

    const teamCode = body.teamCode || null;

    const db = getDb(c.env);
    const [savedResult] = await db.insert(userResults).values({
      userId,
      dassDepressionEncrypted: encryptedDepression,
      dassAnxietyEncrypted: encryptedAnxiety,
      dassStressEncrypted: encryptedStress,
      hexacoScores: encryptedHexaco,
      teiqueScoresEncrypted: encryptedTeique,
      stabilityAnalysis: encryptedStabilityAnalysis,
      rawResponsesEncrypted: encryptedRawResponses,
      teamCode,
      completedAt: new Date(),
    }).returning();

    recordPulseData({ dassScores, hexacoScores, teiqueScores }, c.env).catch(() => {});

    const userEmail = user!.email;

    if (userEmail) {
      sendFounderAlert(
        userEmail,
        stabilityAnalysis.stabilityScore,
        stabilityAnalysis.overallStability,
        c.env
      ).catch(() => {});
    }

    const scoreIsValid = stabilityAnalysis.stabilityScore > 0;

    if (userEmail && scoreIsValid) {
      sendResultsEmail(userEmail, {
        dassScores,
        hexacoScores,
        teiqueScores,
        stabilityScore: stabilityAnalysis?.stabilityScore,
        overallStability: stabilityAnalysis?.overallStability,
        stabilityAnalysis: stabilityAnalysis ? {
          summary: stabilityAnalysis.summary,
          recommendations: stabilityAnalysis.recommendations,
          clinicalNotes: stabilityAnalysis.clinicalNotes,
          personalityMoodInteraction: stabilityAnalysis.personalityMoodInteraction,
          emotionalIntelligenceInsights: stabilityAnalysis.emotionalIntelligenceInsights,
        } : null,
      }, c.env).then((result) => {
        if (!result.success) {
          if (c.env.NODE_ENV !== 'production') console.error(`Email delivery failed for ${userEmail.slice(0, 2)}***`);
        }
      }).catch(() => {});
    }

    return c.json({
      success: true,
      resultId: savedResult.id,
      stabilityAnalysis,
      emailDispatched: !!userEmail && scoreIsValid,
    });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error analyzing assessment:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to analyze assessment' }, 500);
  }
});

app.post('/submit', async (c) => {
  const ip = resolveIp(c.req);
  if (!submitLimiter(ip)) {
    return c.json({ error: 'Submission limit reached. Please try again later.' }, 429);
  }

  try {
    const body = await c.req.json();
    const validation = validateRequest(submitRequestSchema, body);
    if (!validation.success) {
      return c.json({ error: `Invalid submission data: ${validation.error}` }, 400);
    }

    const { email, assessmentData, teamCode } = validation.data;
    const normalizedEmail = email.toLowerCase().trim().replace(/[<>'"\\;]/g, '');

    const { dassScores, hexacoScores, teiqueScores, rawResponses } = assessmentData;

    const db = getDb(c.env);
    let [existingUser] = await db.select().from(users).where(eq(users.email, normalizedEmail));

    if (!existingUser) {
      const [newUser] = await db.insert(users).values({
        email: normalizedEmail,
      }).returning();
      existingUser = newUser;
    }

    const userId = existingUser.id;

    const prompt = `You are a clinical psychologist AI assistant. Analyze the following psychometric assessment results and provide a comprehensive stability analysis.

## DASS-21 Scores (Depression, Anxiety, Stress Scale):
- Depression: ${dassScores.Depression} (Normal: 0-9, Mild: 10-13, Moderate: 14-20, Severe: 21-27, Extremely Severe: 28+)
- Anxiety: ${dassScores.Anxiety} (Normal: 0-7, Mild: 8-9, Moderate: 10-14, Severe: 15-19, Extremely Severe: 20+)
- Stress: ${dassScores.Stress} (Normal: 0-14, Mild: 15-18, Moderate: 19-25, Severe: 26-33, Extremely Severe: 34+)

## HEXACO-60 Personality Scores (1-5 scale):
- Honesty-Humility: ${hexacoScores.HonestyHumility}
- Emotionality: ${hexacoScores.Emotionality}
- Extraversion: ${hexacoScores.Extraversion}
- Agreeableness: ${hexacoScores.Agreeableness}
- Conscientiousness: ${hexacoScores.Conscientiousness}
- Openness to Experience: ${hexacoScores.OpennessToExperience}

${teiqueScores ? `## TEIQue-SF Emotional Intelligence Scores (1-7 scale):
- Well-being: ${teiqueScores.Wellbeing}
- Self-Control: ${teiqueScores.SelfControl}
- Emotionality: ${teiqueScores.Emotionality}
- Sociability: ${teiqueScores.Sociability}
- Global EI: ${teiqueScores.GlobalEI}` : ''}

Please provide:
1. **Overall Stability Assessment**: Rate as "Stable", "At Risk", or "Critical"
2. **Risk Flags**: Identify any concerning patterns (e.g., Acute Reactive State, High-Functioning Burnout, Emotional Dysregulation)
3. **Personality-Mood Interaction Analysis**: How personality traits may influence or be influenced by current mental health state
4. **Emotional Intelligence Integration**: How EI factors relate to current symptomatology
5. **Recommendations**: Evidence-based suggestions for maintaining or improving psychological wellbeing
6. **Clinical Notes**: Any observations that would be relevant for a mental health professional

Format your response as a structured JSON object with the following schema:
{
  "overallStability": "Stable" | "At Risk" | "Critical",
  "riskFlags": {
    "acuteReactiveState": boolean,
    "highFunctioningBurnout": boolean,
    "emotionalDysregulation": boolean,
    "elevatedDepression": boolean,
    "elevatedAnxiety": boolean,
    "elevatedStress": boolean
  },
  "stabilityScore": number (0-100, where 100 is most stable),
  "personalityMoodInteraction": string,
  "emotionalIntelligenceInsights": string,
  "recommendations": string[],
  "clinicalNotes": string,
  "summary": string
}`;

    const openai = new OpenAI({
      apiKey: c.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: c.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [
        {
          role: 'system',
          content: 'You are a clinical psychologist AI providing professional psychometric analysis. Always respond with valid JSON. Be thorough but compassionate in your analysis.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 2048,
    });

    const analysisContent = response.choices[0]?.message?.content || '{}';
    let stabilityAnalysis = normalizeStabilityAnalysis(JSON.parse(analysisContent), dassScores);

    if (stabilityAnalysis.stabilityScore === 0) {
      stabilityAnalysis = buildFallbackAnalysis(dassScores);
    }

    const encryptedDepression = await encrypt(String(dassScores.Depression), userId, c.env.ENCRYPTION_KEY);
    const encryptedAnxiety = await encrypt(String(dassScores.Anxiety), userId, c.env.ENCRYPTION_KEY);
    const encryptedStress = await encrypt(String(dassScores.Stress), userId, c.env.ENCRYPTION_KEY);
    const encryptedHexaco = await encrypt(JSON.stringify(hexacoScores), userId, c.env.ENCRYPTION_KEY);
    const encryptedTeique = teiqueScores ? await encrypt(JSON.stringify(teiqueScores), userId, c.env.ENCRYPTION_KEY) : null;
    const encryptedStabilityAnalysis = await encrypt(JSON.stringify(stabilityAnalysis), userId, c.env.ENCRYPTION_KEY);
    const encryptedRawResponses = rawResponses ? await encrypt(JSON.stringify(rawResponses), userId, c.env.ENCRYPTION_KEY) : null;

    await db.insert(userResults).values({
      userId,
      dassDepressionEncrypted: encryptedDepression,
      dassAnxietyEncrypted: encryptedAnxiety,
      dassStressEncrypted: encryptedStress,
      hexacoScores: encryptedHexaco,
      teiqueScoresEncrypted: encryptedTeique,
      stabilityAnalysis: encryptedStabilityAnalysis,
      rawResponsesEncrypted: encryptedRawResponses,
      teamCode: teamCode || null,
      completedAt: new Date(),
    });

    recordPulseData({ dassScores, hexacoScores, teiqueScores }, c.env).catch(() => {});

    sendFounderAlert(
      normalizedEmail,
      stabilityAnalysis?.stabilityScore ?? 0,
      stabilityAnalysis?.overallStability ?? 'Stable',
      c.env
    ).catch(() => {});

    const scoreIsValid = stabilityAnalysis?.stabilityScore > 0;

    let emailResult: { success: boolean; error?: string } = { success: false, error: 'Score validation gate: zero-score email blocked' };
    if (scoreIsValid) {
      try {
        emailResult = await sendResultsEmail(normalizedEmail, {
          dassScores,
          hexacoScores,
          teiqueScores,
          stabilityScore: stabilityAnalysis?.stabilityScore,
          overallStability: stabilityAnalysis?.overallStability,
          stabilityAnalysis: stabilityAnalysis ? {
            summary: stabilityAnalysis.summary,
            recommendations: stabilityAnalysis.recommendations,
            clinicalNotes: stabilityAnalysis.clinicalNotes,
            personalityMoodInteraction: stabilityAnalysis.personalityMoodInteraction,
            emotionalIntelligenceInsights: stabilityAnalysis.emotionalIntelligenceInsights,
          } : null,
        }, c.env);
      } catch (err) {
        emailResult = { success: false, error: err instanceof Error ? err.message : 'Email dispatch failed' };
      }
    }

    const magicToken = generateToken();
    const magicExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.update(users)
      .set({ magicLinkToken: magicToken, magicLinkExpiresAt: magicExpiresAt })
      .where(eq(users.id, userId));

    const baseUrl = `https://${c.env.APP_DOMAIN}`;
    const magicLink = `${baseUrl}/api/auth/verify?token=${magicToken}`;

    sendMagicLinkEmail(normalizedEmail, magicLink, c.env).catch(() => {});

    return c.json({
      success: true,
      emailDispatched: emailResult.success,
      emailError: emailResult.success ? undefined : emailResult.error,
      magicLinkSent: true,
      stabilityAnalysis,
    });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error in combined submit:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to process assessment submission' }, 500);
  }
});

app.post('/resend-results', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    const userId = user!.id;
    const userEmail = user!.email;

    const db = getDb(c.env);
    const results = await db.select()
      .from(userResults)
      .where(eq(userResults.userId, userId))
      .orderBy(desc(userResults.completedAt))
      .limit(1);

    if (results.length === 0) {
      return c.json({ error: 'No assessment results found' }, 404);
    }

    const latestResult = results[0];

    let dassScores, hexacoScores, teiqueScores, stabilityAnalysis;
    try {
      dassScores = {
        Depression: parseInt(await decrypt(latestResult.dassDepressionEncrypted, userId, c.env.ENCRYPTION_KEY)),
        Anxiety: parseInt(await decrypt(latestResult.dassAnxietyEncrypted, userId, c.env.ENCRYPTION_KEY)),
        Stress: parseInt(await decrypt(latestResult.dassStressEncrypted, userId, c.env.ENCRYPTION_KEY)),
      };
      hexacoScores = latestResult.hexacoScores
        ? JSON.parse(await decrypt(latestResult.hexacoScores, userId, c.env.ENCRYPTION_KEY))
        : null;
      teiqueScores = latestResult.teiqueScoresEncrypted
        ? JSON.parse(await decrypt(latestResult.teiqueScoresEncrypted, userId, c.env.ENCRYPTION_KEY))
        : null;
      const rawAnalysis = latestResult.stabilityAnalysis
        ? JSON.parse(await decrypt(latestResult.stabilityAnalysis, userId, c.env.ENCRYPTION_KEY))
        : null;
      stabilityAnalysis = normalizeStabilityAnalysis(rawAnalysis, dassScores);
    } catch {
      return c.json({ error: 'Failed to decrypt results for re-send' }, 500);
    }

    if (!dassScores || !hexacoScores) {
      return c.json({ error: 'Incomplete result data' }, 500);
    }

    const emailResult = await sendResultsEmail(userEmail, {
      dassScores,
      hexacoScores,
      teiqueScores,
      stabilityScore: stabilityAnalysis.stabilityScore,
      overallStability: stabilityAnalysis.overallStability,
      stabilityAnalysis: {
        summary: stabilityAnalysis.summary,
        recommendations: stabilityAnalysis.recommendations,
        clinicalNotes: stabilityAnalysis.clinicalNotes,
        personalityMoodInteraction: stabilityAnalysis.personalityMoodInteraction,
        emotionalIntelligenceInsights: stabilityAnalysis.emotionalIntelligenceInsights,
      },
    }, c.env);

    return c.json({
      success: emailResult.success,
      error: emailResult.success ? undefined : emailResult.error,
    });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error resending results:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to resend results' }, 500);
  }
});

app.get('/results', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    const userId = user!.id;

    const db = getDb(c.env);
    const results = await db.select()
      .from(userResults)
      .where(eq(userResults.userId, userId));

    const decryptedResults = await Promise.all(results.map(async (result) => {
      try {
        let hexacoScores = null;
        if (result.hexacoScores) {
          try {
            hexacoScores = JSON.parse(await decrypt(result.hexacoScores, userId, c.env.ENCRYPTION_KEY));
          } catch {
            hexacoScores = JSON.parse(result.hexacoScores);
          }
        }

        let stabilityAnalysis = null;
        if (result.stabilityAnalysis) {
          try {
            stabilityAnalysis = JSON.parse(await decrypt(result.stabilityAnalysis, userId, c.env.ENCRYPTION_KEY));
          } catch {
            try { stabilityAnalysis = JSON.parse(result.stabilityAnalysis); } catch {}
          }
        }

        let teiqueScores = null;
        if (result.teiqueScoresEncrypted) {
          try {
            teiqueScores = JSON.parse(await decrypt(result.teiqueScoresEncrypted, userId, c.env.ENCRYPTION_KEY));
          } catch {
            try { teiqueScores = JSON.parse(result.teiqueScoresEncrypted); } catch {}
          }
        }

        const dassScores = {
          Depression: parseInt(await decrypt(result.dassDepressionEncrypted, userId, c.env.ENCRYPTION_KEY)),
          Anxiety: parseInt(await decrypt(result.dassAnxietyEncrypted, userId, c.env.ENCRYPTION_KEY)),
          Stress: parseInt(await decrypt(result.dassStressEncrypted, userId, c.env.ENCRYPTION_KEY)),
        };

        stabilityAnalysis = normalizeStabilityAnalysis(stabilityAnalysis, dassScores);

        return {
          id: result.id,
          dassScores,
          hexacoScores,
          teiqueScores,
          stabilityAnalysis,
          completedAt: result.completedAt,
          createdAt: result.createdAt,
        };
      } catch (decryptError) {
        if (c.env.NODE_ENV !== 'production') console.error('Decryption error for result:', result.id);
        return {
          id: result.id,
          error: 'Failed to decrypt data',
          completedAt: result.completedAt,
        };
      }
    }));

    return c.json({ results: decryptedResults });
  } catch (error) {
    if (c.env.NODE_ENV !== 'production') console.error('Error fetching results:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Failed to fetch results' }, 500);
  }
});

export default app;
