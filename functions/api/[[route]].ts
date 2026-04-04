import { Hono } from "hono";
import type { Env } from "../../functions-src/types";
import { securityHeaders } from "../../functions-src/middleware/security";
import { csrfGuard } from "../../functions-src/middleware/csrf";
import authRoutes from "../../functions-src/routes/auth";
import webhooksRoutes from "../../functions-src/routes/webhooks";
import stabilityRoutes from "../../functions-src/routes/stability";
import analyticsRoutes from "../../functions-src/routes/analytics";
import pulseRoutes from "../../functions-src/routes/pulse";
import teamsRoutes from "../../functions-src/routes/teams";
import investorRoutes from "../../functions-src/routes/investor";
import contactRoutes from "../../functions-src/routes/contact";

const app = new Hono<{ Bindings: Env }>();

// Global security headers
app.use("*", securityHeaders());

// CSRF guard on all /api/* routes
app.use("/api/*", csrfGuard());

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Mount routes
app.route("/api/auth", authRoutes);
app.route("/api/webhooks", webhooksRoutes);
app.route("/api/stability", stabilityRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/pulse", pulseRoutes);
app.route("/api/teams", teamsRoutes);
app.route("/api/investor", investorRoutes);
app.route("/api/contact", contactRoutes);

// 404 handler
app.notFound((c) => c.json({ error: "Not found" }, 404));

export const onRequest = app.fetch;
