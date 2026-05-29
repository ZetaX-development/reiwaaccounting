// Vitest setup: provide minimum env so lazy env loader doesn't crash on first read.
// Individual tests can still override these via `process.env = { ...original }` patterns.
process.env.NODE_ENV = 'test';
// テスト中は dev bypass を無効にして auth middleware を通常動作させる
process.env.DEV_BYPASS_AUTH = '';
// テスト中はメール送信を無効にする（実際にメールが飛ばないよう認証情報をクリア）
process.env.GMAIL_USER = '';
process.env.GMAIL_APP_PASSWORD = '';
process.env.SENDGRID_API_KEY = '';
process.env.EMAIL_FROM = '';
// Tests run against an isolated Postgres on port 5433 (see docker-compose.yml
// `postgres-test` service). Falls back to the dev DB if TEST_DATABASE_URL is
// explicitly cleared — but `npm test` sets it via the script.
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ??
  'postgresql://bookmee:bookmee_test@localhost:5433/bookmee_test';
process.env.MF_BASE_URL ??= 'https://api.biz.moneyforward.com';

// Supabase Auth (spec 17b) — test values
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
// Must be >= 32 chars for jose HS256
process.env.SUPABASE_JWT_SECRET ??= 'test-secret-32-chars-minimum-len!!';
process.env.SUPABASE_JWT_AUDIENCE ??= 'authenticated';

// Ensure demo-firm exists in the test DB before any test runs.
import { PrismaClient } from '@prisma/client';
const _setupPrisma = new PrismaClient();
await _setupPrisma.firm.upsert({
  where: { id: 'demo-firm' },
  update: { name: 'bookmee デモ事務所', slug: 'demo', isDemo: true },
  create: {
    id: 'demo-firm',
    name: 'bookmee デモ事務所',
    slug: 'demo',
    isDemo: true,
  },
});

// Seed a test FirmMember so requireAuth passes in all tests.
await _setupPrisma.firmMember.upsert({
  where: {
    firmId_authUserId: { firmId: 'demo-firm', authUserId: 'test-user-id' },
  },
  update: { role: 'owner', status: 'active', email: 'test@example.com' },
  create: {
    firmId: 'demo-firm',
    authUserId: 'test-user-id',
    role: 'owner',
    status: 'active',
    email: 'test@example.com',
  },
});

await _setupPrisma.$disconnect();
