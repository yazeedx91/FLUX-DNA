import { createMiddleware } from 'hono/factory';

export function securityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-XSS-Protection', '1; mode=block');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
    c.header('X-DNS-Prefetch-Control', 'off');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'self' https://flux-dna.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
        "script-src-attr 'none'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
      ].join('; ')
    );
  });
}
