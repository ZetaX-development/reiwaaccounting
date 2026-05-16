// Vitest setup: provide minimum env so lazy env loader doesn't crash on first read.
// Individual tests can still override these via `process.env = { ...original }` patterns.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??=
  'postgresql://zeimee:zeimee_dev@localhost:5432/zeimee';
process.env.MF_BASE_URL ??= 'https://api.biz.moneyforward.com';
