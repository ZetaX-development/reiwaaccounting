// Vitest setup: provide minimum env so lazy env loader doesn't crash on first read.
// Individual tests can still override these via `process.env = { ...original }` patterns.
process.env.NODE_ENV = 'test';
// Tests run against an isolated Postgres on port 5433 (see docker-compose.yml
// `postgres-test` service). Falls back to the dev DB if TEST_DATABASE_URL is
// explicitly cleared — but `npm test` sets it via the script.
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ??
  'postgresql://zeimee:zeimee_test@localhost:5433/zeimee_test';
process.env.MF_BASE_URL ??= 'https://api.biz.moneyforward.com';
