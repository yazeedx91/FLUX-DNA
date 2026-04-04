import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.js';

const app = new Hono<{ Bindings: Env }>();

const analyticsEventSchema = z.object({
  event: z.string().min(1).max(100),
});

const ALLOWED_EVENTS = new Set([
  'get_started_click',
  'assessment_complete',
  'page_view',
]);

// In-memory counters (per-isolate)
const eventCounts: Record<string, number> = {};
const lastReset = Date.now();

const analyticsRateMap = new Map<string, number[]>();
const ANALYTICS_RATE_LIMIT = 30;
const ANALYTICS_RATE_WINDOW = 60000;

function checkAnalyticsRate(ip: string): boolean {
  const now = Date.now();
  const timestamps = analyticsRateMap.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < ANALYTICS_RATE_WINDOW);
  if (recent.length >= ANALYTICS_RATE_LIMIT) return false;
  recent.push(now);
  analyticsRateMap.set(ip, recent);
  return true;
}

app.post('/event', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  if (!checkAnalyticsRate(ip)) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const validation = analyticsEventSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid event payload' }, 400);
  }
  const { event } = validation.data;

  if (!ALLOWED_EVENTS.has(event)) {
    return c.json({ error: 'Invalid event' }, 400);
  }

  eventCounts[event] = (eventCounts[event] || 0) + 1;
  return c.json({ ok: true });
});

app.get('/summary', (c) => {
  const uptimeHours = ((Date.now() - lastReset) / 3600000).toFixed(1);
  return c.json({
    counts: { ...eventCounts },
    uptimeHours,
    since: new Date(lastReset).toISOString(),
  });
});

export default app;
