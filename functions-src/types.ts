export interface Env {
  DATABASE_URL: string;
  RESEND_API_KEY: string;
  OPENAI_API_KEY: string;
  AI_INTEGRATIONS_OPENAI_API_KEY: string;
  AI_INTEGRATIONS_OPENAI_BASE_URL: string;
  ENCRYPTION_KEY: string;
  APP_DOMAIN: string;
  RESEND_FROM_DOMAIN?: string;
  RESEND_WEBHOOK_SECRET?: string;
  NODE_ENV?: string;
}
