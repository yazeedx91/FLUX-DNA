import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.js';
import { getDb } from '../db.js';
import { inboundMessages } from '../../shared/schema.js';

const app = new Hono<{ Bindings: Env }>();

const resendWebhookSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().optional(),
    from: z.string().optional(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    created_at: z.string().optional(),
  }).passthrough(),
});

async function verifyResendSignature(
  headers: { get: (name: string) => string | null },
  rawBody: string,
  signingSecret: string | undefined
): Promise<boolean> {
  if (!signingSecret) return true;

  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestampNum = parseInt(svixTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > 300) return false;

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const secretBase64 = signingSecret.replace('whsec_', '');
  const secretBytes = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  const signatures = svixSignature.split(' ');
  return signatures.some(sig => {
    const sigValue = sig.replace(/^v\d+,/, '');
    return expected === sigValue;
  });
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

app.post('/resend', async (c) => {
  try {
    const rawBody = await c.req.text();
    const body = JSON.parse(rawBody);
    const headers = c.req.raw.headers;

    if (!await verifyResendSignature(headers, rawBody, c.env.RESEND_WEBHOOK_SECRET)) {
      if (c.env.NODE_ENV !== 'production') console.warn('FLUX webhook: invalid signature rejected');
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const validation = resendWebhookSchema.safeParse(body);
    if (!validation.success) {
      if (c.env.NODE_ENV !== 'production') console.warn('FLUX webhook: malformed payload');
      return c.json({ error: 'Invalid payload' }, 400);
    }

    const { type, data } = validation.data;

    const fromEmail = typeof data.from === 'string' ? data.from : '';
    const toEmail = Array.isArray(data.to) ? data.to[0] || '' : (data.to || '');
    const subject = data.subject || '';
    const textBody = data.text || '';
    const htmlBody = data.html || '';

    const db = getDb(c.env);
    await db.insert(inboundMessages).values({
      eventType: type,
      resendEmailId: data.email_id || null,
      fromEmail,
      toEmail,
      subject,
      textBody: textBody.substring(0, 10000),
      htmlBody: htmlBody.substring(0, 50000),
      rawPayload: JSON.stringify(data).substring(0, 100000),
      status: 'received',
    });

    if (c.env.NODE_ENV !== 'production') console.log(`FLUX webhook [${type}] from ${maskEmail(fromEmail)} → ${maskEmail(toEmail)}: "${subject.substring(0, 50)}"`);

    return c.json({ received: true });
  } catch (error) {
    if ((c.env as Env).NODE_ENV !== 'production') console.error('FLUX webhook error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'FLUX Two-Way Communication Bridge',
    capabilities: ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.received'],
  });
});

export default app;
