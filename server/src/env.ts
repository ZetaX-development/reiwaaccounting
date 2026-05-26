import { z } from 'zod';

// Note: dotenv loading is done in src/bootstrap.ts so tests can manipulate
// process.env without .env contents leaking back in.

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STALE_THRESHOLD_SEC: z.coerce.number().int().positive().default(3600),
  MAX_AGE_SEC: z.coerce.number().int().positive().default(21600),
  MF_CLIENT_ID: z.string().default(''),
  MF_CLIENT_SECRET: z.string().default(''),
  MF_REDIRECT_URI: z.string().default(''),
  // OAuth authorize/token endpoints (Money Forward Cloud common auth server v2)
  MF_AUTH_BASE_URL: z.string().default('https://api.biz.moneyforward.com'),
  // Cloud Accounting data API base
  MF_ACCOUNTING_BASE_URL: z
    .string()
    .default('https://api-accounting.moneyforward.com'),
  // Deprecated alias kept so existing .env files don't break the loader.
  MF_BASE_URL: z.string().default(''),
  SENDGRID_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default(''),
  SLACK_BOT_TOKEN: z.string().default(''),
  CHATWORK_API_TOKEN: z.string().default(''),
  LINEWORKS_BOT_ID: z.string().default(''),
  LINEWORKS_CLIENT_ID: z.string().default(''),
  LINEWORKS_CLIENT_SECRET: z.string().default(''),
  LINEWORKS_SERVICE_ACCOUNT: z.string().default(''),
  LINEWORKS_PRIVATE_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_VISION_MODEL: z.string().default('gpt-5'),
  OUTREACH_CHANNEL: z.enum(['mock', 'email', 'line']).default('mock'),
  OUTREACH_AUTO: z.coerce.boolean().default(false),
  OUTREACH_EMAIL_FROM: z.string().default('bookmee@example.com'),
  OUTREACH_LINE_TOKEN: z.string().default(''),

  // Spec 15: Google Drive 連携
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z
    .string()
    .default('http://localhost:3000/api/integrations/drive/oauth/callback'),
  GOOGLE_DRIVE_WEBHOOK_BASE_URL: z.string().default(''),

  // Spec 16: LINE Messaging API
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  LINE_CHANNEL_SECRET: z.string().default(''),
  LINE_WEBHOOK_BASE_URL: z.string().default(''),
  LINE_CHANNEL_ID: z.string().default(''),

  // Spec 20: MF自動入力用ブラウザログイン
  MF_EMAIL: z.string().default(''),
  MF_PASSWORD: z.string().default(''),

  // Spec 17b: Supabase Auth
  SUPABASE_URL: z.string().default(''),
  SUPABASE_ANON_KEY: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_JWT_SECRET: z.string().default(''),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

// Lazy singleton: only validated on first read, so tests can manipulate
// process.env before any consumer touches `env`.
let _cached: Env | undefined;
export const env = new Proxy({} as Env, {
  get(_target, prop) {
    if (!_cached) _cached = loadEnv();
    return _cached[prop as keyof Env];
  },
});

// Test-only helper to reset the cached env (used between tests if needed).
export function __resetEnvCache(): void {
  _cached = undefined;
}
