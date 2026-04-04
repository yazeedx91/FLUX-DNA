import { Hono } from 'hono';
import { z } from 'zod';
import { contactInquiries } from '../../shared/schema.js';
import { getDb } from '../db.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import type { Env } from '../types.js';

const app = new Hono<{ Bindings: Env }>();

const contactLimiter = createRateLimiter(60 * 60 * 1000, 5);

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

const contactSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).transform(stripHtml),
  email: z.string().email('Invalid email format').max(255),
  company: z.string().max(200).optional().transform(val => val ? stripHtml(val) : val),
  inquiryType: z.enum(['business', 'partnership', 'enterprise', 'research', 'other']),
  message: z.string().min(10, 'Message must be at least 10 characters').max(2000).transform(stripHtml),
});

app.post('/submit', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (!contactLimiter(ip)) {
    return c.json({ error: 'Too many inquiries. Please try again later.' }, 429);
  }

  try {
    const body = await c.req.json().catch(() => null);
    const validation = contactSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: validation.error.errors[0].message }, 400);
    }

    const { name, email, company, message, inquiryType } = validation.data;
    const sanitizedEmail = email.toLowerCase().trim().replace(/[<>'"\\;]/g, '');
    const sanitizedName = name.replace(/[<>'"\\;]/g, '');

    const db = getDb(c.env);
    await db.insert(contactInquiries).values({
      name: sanitizedName,
      email: sanitizedEmail,
      company: company || null,
      inquiryType,
      message,
    });

    return c.json({ success: true, message: "Your inquiry has been received. We'll be in touch within 24 hours." });
  } catch (error) {
    console.error('Contact error:', error instanceof Error ? error.message : 'Unknown');
    return c.json({ error: 'Failed to submit inquiry' }, 500);
  }
});

export default app;
