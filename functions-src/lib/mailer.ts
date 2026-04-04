import { Resend } from 'resend';
import { render } from '@react-email/components';
import { Env } from '../types.js';
import { FluxMagicLink } from '../../server/emails/FluxMagicLink.js';
import { FluxResultsReport } from '../../server/emails/FluxResultsReport.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithRetry(
  sendFn: () => Promise<void>,
  context: string,
  email: string,
  isProduction: boolean
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sendFn();
      if (!isProduction) {
        console.log(`FLUX ${context} dispatched [${maskEmail(email)}]`);
      }
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      if (!isProduction) {
        console.error(`FLUX ${context} attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        return { success: false, error: `Failed after ${MAX_RETRIES} attempts` };
      }
    }
  }
  return { success: false, error: 'Exhausted retries' };
}

export async function sendMagicLinkEmail(email: string, magicLink: string, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) {
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const isProduction = env.NODE_ENV === 'production';

  const result = await sendWithRetry(async () => {
    const securityCode = 'FX-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    const emailHtml = await render(
      FluxMagicLink({ magicLink, securityCode })
    );

    const fromDomain = env.RESEND_FROM_DOMAIN ?? 'resend.dev';
    await resend.emails.send({
      from: `FLUX-DNA <noreply@${fromDomain}>`,
      replyTo: `support@${fromDomain}`,
      to: email,
      subject: 'Your FLUX-DNA Portal Access Link',
      headers: {
        'X-Entity-Ref-ID': globalThis.crypto.randomUUID(),
        'List-Unsubscribe': `<mailto:unsubscribe@${fromDomain}>`,
      },
      html: emailHtml,
    });
  }, 'magic link', email, isProduction);

  if (!result.success) {
    throw new Error(result.error || 'Failed to send magic link email');
  }
}

const ADMIN_EMAIL = 'yazeedx91@gmail.com';

export async function sendFounderAlert(
  userEmail: string,
  stabilityScore: number,
  overallStability: string,
  env: Env
): Promise<void> {
  if (!env.RESEND_API_KEY) return;

  const resend = new Resend(env.RESEND_API_KEY);

  const timestamp = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const fromDomain = env.RESEND_FROM_DOMAIN ?? 'resend.dev';

  try {
    await resend.emails.send({
      from: `FLUX-DNA Monitor <noreply@${fromDomain}>`,
      to: ADMIN_EMAIL,
      subject: `FLUX-DNA Alert — New Assessment [Score: ${stabilityScore}/100]`,
      html: `
        <div style="font-family: 'Inter', -apple-system, sans-serif; background-color: #0f172a; padding: 40px 20px;">
          <div style="max-width: 480px; margin: 0 auto; background-color: #0f172a; border: 1px solid rgba(99,102,241,0.2); border-radius: 16px; padding: 32px; box-shadow: 0 0 60px rgba(79,70,229,0.1);">
            <p style="font-size: 10px; font-weight: 500; color: #6366F1; letter-spacing: 3px; margin: 0 0 20px 0; font-family: monospace;">SOVEREIGN MONITOR</p>
            <h2 style="font-size: 20px; font-weight: 300; color: #F1F5F9; margin: 0 0 24px 0;">New Assessment Completed</h2>
            <div style="background: rgba(99,102,241,0.06); border: 1px solid rgba(99,102,241,0.15); border-radius: 12px; padding: 20px; margin: 0 0 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="font-size: 11px; color: #64748B; padding: 6px 0; font-family: monospace; letter-spacing: 1px;">USER</td>
                  <td style="font-size: 13px; color: #E2E8F0; padding: 6px 0; text-align: right;">${maskEmail(userEmail)}</td>
                </tr>
                <tr>
                  <td style="font-size: 11px; color: #64748B; padding: 6px 0; font-family: monospace; letter-spacing: 1px;">SCORE</td>
                  <td style="font-size: 13px; color: #E2E8F0; padding: 6px 0; text-align: right; font-weight: 600;">${stabilityScore}/100</td>
                </tr>
                <tr>
                  <td style="font-size: 11px; color: #64748B; padding: 6px 0; font-family: monospace; letter-spacing: 1px;">STATUS</td>
                  <td style="font-size: 13px; color: #6366F1; padding: 6px 0; text-align: right; text-transform: uppercase; letter-spacing: 1px;">${overallStability}</td>
                </tr>
                <tr>
                  <td style="font-size: 11px; color: #64748B; padding: 6px 0; font-family: monospace; letter-spacing: 1px;">TIMESTAMP</td>
                  <td style="font-size: 11px; color: #94A3B8; padding: 6px 0; text-align: right;">${timestamp}</td>
                </tr>
              </table>
            </div>
            <p style="font-size: 10px; color: #334155; margin: 0; text-align: center; letter-spacing: 2px; font-family: monospace;">FLUX-DNA EMPIRE MONITOR</p>
          </div>
        </div>
      `,
    });
  } catch {}
}

interface ResultsEmailData {
  dassScores: { Depression: number; Anxiety: number; Stress: number };
  hexacoScores: {
    HonestyHumility: number;
    Emotionality: number;
    Extraversion: number;
    Agreeableness: number;
    Conscientiousness: number;
    OpennessToExperience: number;
  };
  teiqueScores?: {
    Wellbeing: number;
    SelfControl: number;
    Emotionality: number;
    Sociability: number;
    GlobalEI: number;
  } | null;
  stabilityScore?: number;
  overallStability?: string;
  stabilityAnalysis?: {
    summary?: string;
    recommendations?: string[];
    clinicalNotes?: string;
    personalityMoodInteraction?: string;
    emotionalIntelligenceInsights?: string;
  } | null;
}

export async function sendResultsEmail(
  email: string,
  data: ResultsEmailData,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) {
    return { success: true };
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const isProduction = env.NODE_ENV === 'production';

  return sendWithRetry(async () => {
    const emailHtml = await render(
      FluxResultsReport({
        dassScores: data.dassScores,
        hexacoScores: data.hexacoScores,
        teiqueScores: data.teiqueScores,
        stabilityScore: data.stabilityScore,
        overallStability: data.overallStability,
        stabilityAnalysis: data.stabilityAnalysis,
        completedAt: new Date().toISOString(),
      })
    );

    const fromDomain = env.RESEND_FROM_DOMAIN ?? 'resend.dev';
    await resend.emails.send({
      from: `FLUX-DNA <noreply@${fromDomain}>`,
      replyTo: `support@${fromDomain}`,
      to: email,
      subject: 'Your FLUX-DNA Psychometric Blueprint',
      headers: {
        'X-Entity-Ref-ID': globalThis.crypto.randomUUID(),
        'List-Unsubscribe': `<mailto:unsubscribe@${fromDomain}>`,
      },
      html: emailHtml,
    });
  }, 'results report', email, isProduction);
}
