import { createMiddleware } from 'hono/factory';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfGuard() {
  return createMiddleware(async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;

    // Skip safe methods and webhook paths
    if (!MUTATING_METHODS.has(method) || path.startsWith('/api/webhooks')) {
      return next();
    }

    const origin = c.req.header('origin');
    const host = c.req.header('host') ?? '';

    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host && originHost !== 'flux-dna.com') {
          return c.json({ error: 'Cross-origin request blocked' }, 403);
        }
      } catch {
        // Malformed origin — allow (mirrors original behaviour)
      }
    }

    return next();
  });
}
