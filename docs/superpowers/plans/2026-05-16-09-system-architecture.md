# 09 System Architecture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the production architecture foundation (Node.js + TypeScript + Fastify + Prisma + PostgreSQL) so the existing Vanilla frontend reads its data through `fetch('/api/...')` instead of an inline `clients[]` array. After this plan, every later spec (01–08) implements its features on this foundation.

**Architecture:** Monorepo layout — existing `index.html` / `styles.css` / `script.js` stay at repo root and are served by Fastify (`@fastify/static`). A new `server/` folder holds the TypeScript backend. PostgreSQL via Docker Compose. Stale-While-Revalidate cache strategy is built into `sync-service.ts`. The `VendorAdapter` interface lets `mf-api.ts` (real, OAuth scaffold only here) and `freee-mock.ts` (fixed mock) be swapped freely. Notification adapters in this plan are interface-only stubs — full implementations come in spec 03.

**Tech Stack:** Node.js 20+, TypeScript 5+, Fastify 4, Prisma 5, PostgreSQL 16, Vitest 1, Pino, Zod, undici, dotenv, @fastify/static, @fastify/cors, Docker Compose. (BullMQ + Redis are deferred to spec 03; for now SWR uses a fire-and-forget async pattern.)

**Out of scope (defer to later specs):** real MF API calls, freee real connection, notification real send, any feature-specific UI changes (cross-vendor badges, mode toggle, etc.), authentication.

---

## File Structure

```
zeimee/
├── index.html                       # MODIFY (no changes in this plan; verified still works)
├── styles.css                       # untouched
├── script.js                        # MODIFY (Tasks 16, 18) — switch from clients[] to fetch()
├── README.md                        # MODIFY (Task 17)
├── docker-compose.yml               # CREATE (Task 2)
├── .gitignore                       # MODIFY (Task 1) — add node_modules, .env, dist
├── server/
│   ├── package.json                 # CREATE (Task 1)
│   ├── tsconfig.json                # CREATE (Task 1)
│   ├── vitest.config.ts             # CREATE (Task 1)
│   ├── .env.example                 # CREATE (Task 3)
│   ├── prisma/
│   │   ├── schema.prisma            # CREATE (Task 4)
│   │   └── seed.ts                  # CREATE (Task 10)
│   ├── src/
│   │   ├── server.ts                # CREATE (Task 6, MODIFY 11/12/13/15)
│   │   ├── env.ts                   # CREATE (Task 3)
│   │   ├── lib/
│   │   │   ├── prisma.ts            # CREATE (Task 5)
│   │   │   └── logger.ts            # CREATE (Task 5)
│   │   ├── routes/
│   │   │   ├── health.ts            # CREATE (Task 6)
│   │   │   ├── clients.ts           # CREATE (Task 11), MODIFY (Task 12)
│   │   │   └── sync.ts              # CREATE (Task 13)
│   │   ├── services/
│   │   │   ├── client-service.ts    # CREATE (Task 11)
│   │   │   └── sync-service.ts      # CREATE (Task 13)
│   │   └── adapters/
│   │       ├── vendor-adapter.ts    # CREATE (Task 7)
│   │       ├── freee-mock.ts        # CREATE (Task 8)
│   │       ├── mf-api.ts            # CREATE (Task 9)
│   │       └── notification.ts      # CREATE (Task 14)
│   └── tests/
│       ├── env.test.ts              # CREATE (Task 3)
│       ├── routes/
│       │   ├── health.test.ts       # CREATE (Task 6)
│       │   ├── clients.test.ts      # CREATE (Task 11/12)
│       │   └── sync.test.ts         # CREATE (Task 13)
│       ├── services/
│       │   ├── client-service.test.ts # CREATE (Task 11)
│       │   └── sync-service.test.ts   # CREATE (Task 13)
│       └── adapters/
│           ├── freee-mock.test.ts   # CREATE (Task 8)
│           └── mf-api.test.ts       # CREATE (Task 9)
```

**Boundaries:**
- `routes/*` only validates input + delegates to `services/*`. No business logic in routes.
- `services/*` orchestrate Prisma + adapter calls. No HTTP concerns.
- `adapters/*` hide external systems behind a small interface.
- `lib/*` are cross-cutting singletons (Prisma client, Pino logger).
- `env.ts` is the single source of truth for `process.env` reads.

---

## Working directory convention

All shell commands in this plan run from `/home/kkouta/poc/zeimee/server/` **unless otherwise noted**. Tasks that need root commands (Docker Compose, git) call this out explicitly.

---

## Task 1: Initialize the `server/` Node.js project

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/.gitignore`
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "zeimee-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "seed": "tsx prisma/seed.ts"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@fastify/static": "^7.0.4",
    "@prisma/client": "^5.22.0",
    "dotenv": "^16.4.5",
    "fastify": "^4.28.1",
    "pino": "^9.5.0",
    "pino-pretty": "^11.3.0",
    "undici": "^6.20.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.5",
    "prisma": "^5.22.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vitest": "^1.6.1"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "prisma/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create `server/.gitignore`**

```
node_modules
dist
.env
prisma/migrations/*/migration_lock.toml.bak
```

- [ ] **Step 5: Append to repo-root `.gitignore`**

Modify `/home/kkouta/poc/zeimee/.gitignore`. Append:

```
# server
server/node_modules
server/dist
server/.env
```

- [ ] **Step 6: Install dependencies**

Run from `server/`: `npm install`
Expected: `node_modules` is created and `package-lock.json` is generated. No errors.

- [ ] **Step 7: Verify TypeScript compiles (no source files yet, so just check tsc parses config)**

Run from `server/`: `npx tsc --noEmit -p .`
Expected: Exits 0 (or "No inputs were found" — that's fine; we have no source files yet).

- [ ] **Step 8: Commit**

Run from repo root:
```bash
git add server/package.json server/tsconfig.json server/vitest.config.ts server/.gitignore server/package-lock.json .gitignore
git commit -m "chore(server): initialize TypeScript + Fastify project skeleton"
```

---

## Task 2: Docker Compose for PostgreSQL

**Files:**
- Create: `docker-compose.yml` (repo root)

- [ ] **Step 1: Create `/home/kkouta/poc/zeimee/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: zeimee-postgres
    environment:
      POSTGRES_USER: zeimee
      POSTGRES_PASSWORD: zeimee_dev
      POSTGRES_DB: zeimee
    ports:
      - "5432:5432"
    volumes:
      - zeimee_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zeimee -d zeimee"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  zeimee_pg_data:
```

- [ ] **Step 2: Start the database**

Run from repo root: `docker compose up -d postgres`
Expected: `Container zeimee-postgres  Started`

- [ ] **Step 3: Verify Postgres is reachable**

Run: `docker compose exec postgres pg_isready -U zeimee -d zeimee`
Expected: `/var/run/postgresql:5432 - accepting connections`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add Docker Compose for local PostgreSQL"
```

---

## Task 3: Environment variable validation (`env.ts`)

**Files:**
- Create: `server/src/env.ts`
- Create: `server/.env.example`
- Create: `server/tests/env.test.ts`

- [ ] **Step 1: Create `server/.env.example`**

```
DATABASE_URL=postgresql://zeimee:zeimee_dev@localhost:5432/zeimee
PORT=3000
NODE_ENV=development
STALE_THRESHOLD_SEC=3600
MAX_AGE_SEC=21600

# MF API (filled in spec 01 implementation; placeholders OK for now)
MF_CLIENT_ID=
MF_CLIENT_SECRET=
MF_REDIRECT_URI=http://localhost:3000/api/mf/oauth/callback
MF_BASE_URL=https://api.biz.moneyforward.com

# Notification (filled in spec 03 implementation)
SENDGRID_API_KEY=
EMAIL_FROM=zeimee@example.com
SLACK_BOT_TOKEN=
CHATWORK_API_TOKEN=
LINEWORKS_BOT_ID=
LINEWORKS_CLIENT_ID=
LINEWORKS_CLIENT_SECRET=
LINEWORKS_SERVICE_ACCOUNT=
LINEWORKS_PRIVATE_KEY=
```

- [ ] **Step 2: Copy `.env.example` to `.env`**

Run from `server/`: `cp .env.example .env`
Expected: `.env` exists locally (gitignored).

- [ ] **Step 3: Write `server/tests/env.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadEnv', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
  });

  it('throws when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const { loadEnv } = await import('../src/env.js');
    expect(() => loadEnv()).toThrow(/DATABASE_URL/);
  });

  it('parses required and optional vars with defaults', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/d';
    delete process.env.PORT;
    delete process.env.STALE_THRESHOLD_SEC;
    const { loadEnv } = await import('../src/env.js');
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe('postgresql://u:p@h:5432/d');
    expect(env.PORT).toBe(3000);
    expect(env.STALE_THRESHOLD_SEC).toBe(3600);
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/env.test.ts`
Expected: FAIL — `Cannot find module '../src/env.js'`

- [ ] **Step 5: Implement `server/src/env.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STALE_THRESHOLD_SEC: z.coerce.number().int().positive().default(3600),
  MAX_AGE_SEC: z.coerce.number().int().positive().default(21600),
  MF_CLIENT_ID: z.string().default(''),
  MF_CLIENT_SECRET: z.string().default(''),
  MF_REDIRECT_URI: z.string().default(''),
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
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

export const env = loadEnv();
```

- [ ] **Step 6: Re-run the test to confirm it passes**

Run from `server/`: `npx vitest run tests/env.test.ts`
Expected: 2 passing.

- [ ] **Step 7: Commit**

```bash
git add server/src/env.ts server/.env.example server/tests/env.test.ts
git commit -m "feat(server): add env loader with Zod validation"
```

---

## Task 4: Prisma schema and first migration

**Files:**
- Create: `server/prisma/schema.prisma`

This task installs the entire DB schema from spec 09 (every model) so later specs (01–08) can `prisma migrate dev` only when adding fields. The seed (Task 10) and clients endpoint (Task 11) only touch `Client`/`Entry`/etc — but having all models defined now avoids schema churn.

- [ ] **Step 1: Create `server/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Client {
  id              String   @id @default(cuid())
  name            String
  industry        String   @default("その他")
  vendor          String   @default("mf") // 'freee' | 'mf' | 'both'
  mode            String   @default("monthly") // 'monthly' | 'yearend'
  fiscalYearStart DateTime
  fiscalYearEnd   DateTime
  contactPrimary  String   @default("email")
  contactEndpoints Json    @default("{}")
  receiptPolicyOverrides Json?
  yearendKpi      Json?

  // MF OAuth tokens (encryption is future work)
  mfAccessToken    String?
  mfRefreshToken   String?
  mfTokenExpiresAt DateTime?
  mfExternalId     String?

  // Snapshot fields used by dashboard (recomputed on writes)
  progress   Int @default(0)
  tasksOpen  Int @default(0)
  risk       Int @default(0)
  receipt    Int @default(0)
  missing    Int @default(0)
  diff       Int @default(0)
  matches    Int @default(0)

  // Cached display strings
  ownerLabel   String?
  chatMessage  String?
  messageDraft String?

  vendorSyncs       VendorSync[]
  entries           Entry[]
  receipts          Receipt[]
  matchings         Matching[]
  tasks             Task[]
  rules             Rule[]
  threads           Thread[]
  yearendChecklist  YearendCheck[]
  trendData         TrendDatum[]
  monthlyChecks     MonthlyCheck[]

  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}

model VendorSync {
  id        String    @id @default(cuid())
  client    Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String
  vendor    String
  lastSync  DateTime?
  status    String    @default("ok")
  count     Int       @default(0)
  errorMsg  String?
  @@unique([clientId, vendor])
}

model Entry {
  id            String   @id @default(cuid())
  client        Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId      String
  source        String
  sourceEntryId String?
  account       String
  description   String
  amount        Int
  taxClass      String?
  occurredAt    DateTime
  receiptStatus String   @default("na")
  score         Int?
  requestedAt   DateTime?
  raw           Json?
  syncedAt      DateTime @default(now())

  @@index([clientId, occurredAt])
  @@unique([source, sourceEntryId])
}

model Receipt {
  id              String   @id @default(cuid())
  client          Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId        String
  source          String
  sourceReceiptId String?
  status          String
  vendorRef       String?
  amount          Int?
  occurredAt      DateTime
  raw             Json?
  syncedAt        DateTime @default(now())
}

model Matching {
  id            String   @id @default(cuid())
  client        Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId      String
  source        String
  invoiceRef    String
  invoiceAmount Int
  paidAmount    Int
  diffNote      String?
  status        String
  occurredAt    DateTime
  raw           Json?
  syncedAt      DateTime @default(now())
}

model Task {
  id        String   @id @default(cuid())
  client    Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String
  title     String
  note      String
  category  String
  status    String
  score     Int      @default(50)
  stage     String   @default("awaiting_approval")
  assignee  String?
  approver  String?
  ruleId    String?
  history   TaskHistory[]
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}

model TaskHistory {
  id      String   @id @default(cuid())
  task    Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  taskId  String
  at      DateTime @default(now())
  by      String
  action  String
  comment String?
}

model Rule {
  id        String   @id @default(cuid())
  client    Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String
  type      String   @default("custom")
  industry  String?
  title     String
  detail    String   @default("")
  severity  String   @default("mid")
  active    Boolean  @default(true)
  createdBy String   @default("system")
  createdAt DateTime @default(now())
  hits      RuleHit[]
}

model RuleHit {
  id      String   @id @default(cuid())
  rule    Rule     @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  ruleId  String
  at      DateTime @default(now())
  target  String
  outcome String   @default("matched")
}

model Thread {
  id          String   @id @default(cuid())
  client      Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId    String
  channel     String
  direction   String
  subject     String?
  body        String
  preview     String?
  status      String   @default("queued")
  externalId  String?
  errorMsg    String?
  scheduledAt DateTime?
  sentAt      DateTime?
  createdAt   DateTime @default(now())
}

model ReceiptPolicy {
  account          String  @id
  requiresReceipt  Boolean @default(true)
  requiresApproval Boolean @default(false)
  exemptUnder      Int?
  notes            String?
}

model YearendCheck {
  id       String  @id @default(cuid())
  client   Client  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId String
  title    String
  note     String?
  status   String  @default("open")
  order    Int
}

model TrendDatum {
  id         String   @id @default(cuid())
  client     Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId   String
  account    String
  prev3      Json     // number[]
  curr       Float
  changePct  Float
  flag       String   // 'ok' | 'alert'
}

model MonthlyCheck {
  id       String  @id @default(cuid())
  client   Client  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId String
  title    String
  note     String?
  detail   String?
  status   String  @default("open")
  score    Int     @default(50)
}
```

- [ ] **Step 2: Generate Prisma client**

Run from `server/`: `npx prisma generate`
Expected: `✔ Generated Prisma Client (...) to ./node_modules/@prisma/client`

- [ ] **Step 3: Apply migration to dev DB**

Run from `server/` (Postgres must be up from Task 2): `npx prisma migrate dev --name init`
Expected: A migration directory under `prisma/migrations/<ts>_init/` is created and applied. Output ends with `Your database is now in sync with your schema.`

- [ ] **Step 4: Verify with `psql` that all tables exist**

Run from repo root:
```bash
docker compose exec postgres psql -U zeimee -d zeimee -c "\dt"
```
Expected: tables listed include `Client`, `Entry`, `Receipt`, `Matching`, `Task`, `TaskHistory`, `Rule`, `RuleHit`, `Thread`, `ReceiptPolicy`, `YearendCheck`, `VendorSync`, `TrendDatum`, `MonthlyCheck` (Prisma may pluralize differently — confirm names match the schema).

- [ ] **Step 5: Commit**

```bash
git add server/prisma/
git commit -m "feat(server): add Prisma schema and initial migration"
```

---

## Task 5: Prisma client singleton and Pino logger

**Files:**
- Create: `server/src/lib/prisma.ts`
- Create: `server/src/lib/logger.ts`

- [ ] **Step 1: Create `server/src/lib/prisma.ts`**

```ts
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __zeimeePrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__zeimeePrisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__zeimeePrisma = prisma;
}
```

- [ ] **Step 2: Create `server/src/lib/logger.ts`**

```ts
import pino from 'pino';
import { env } from '../env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});
```

- [ ] **Step 3: Type-check the new files**

Run from `server/`: `npx tsc --noEmit -p .`
Expected: Exits 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/
git commit -m "feat(server): add Prisma client singleton and Pino logger"
```

---

## Task 6: Fastify app with health endpoint

**Files:**
- Create: `server/src/server.ts`
- Create: `server/src/routes/health.ts`
- Create: `server/tests/routes/health.test.ts`

- [ ] **Step 1: Write `server/tests/routes/health.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  it('returns ok status with uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/routes/health.test.ts`
Expected: FAIL — `Cannot find module '../../src/server.js'`

- [ ] **Step 3: Create `server/src/routes/health.ts`**

```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }));
}
```

- [ ] **Step 4: Create `server/src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, { origin: true });
  await app.register(healthRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled');
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message },
    });
  });

  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  });
}
```

- [ ] **Step 5: Re-run the test to confirm it passes**

Run from `server/`: `npx vitest run tests/routes/health.test.ts`
Expected: 1 passing.

- [ ] **Step 6: Smoke check the dev server**

Run from `server/`: `npm run dev` (background). Then in another shell:
```bash
curl -s http://localhost:3000/api/health
```
Expected: `{"status":"ok","uptime":<number>}`. Stop the dev server with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts server/src/routes/health.ts server/tests/routes/health.test.ts
git commit -m "feat(server): scaffold Fastify app with /api/health"
```

---

## Task 7: Define `VendorAdapter` interface

**Files:**
- Create: `server/src/adapters/vendor-adapter.ts`

- [ ] **Step 1: Create `server/src/adapters/vendor-adapter.ts`**

```ts
export type VendorSource = 'freee' | 'mf';

export interface RawEntry {
  sourceEntryId: string;
  account: string;
  description: string;
  amount: number;
  taxClass?: string;
  occurredAt: Date;
  receiptStatus?: 'matched' | 'missing' | 'partial' | 'na';
  raw?: unknown;
}

export interface RawReceipt {
  sourceReceiptId: string;
  status: 'attached' | 'missing' | 'candidate';
  vendorRef?: string;
  amount?: number;
  occurredAt: Date;
  raw?: unknown;
}

export interface RawMatching {
  invoiceRef: string;
  invoiceAmount: number;
  paidAmount: number;
  diffNote?: string;
  status: 'matched' | 'open' | 'urgent' | 'done';
  occurredAt: Date;
  raw?: unknown;
}

export interface FetchResult<T> {
  items: T[];
  fetchedAt: Date;
}

export interface VendorAdapter {
  readonly source: VendorSource;
  fetchEntries(externalClientId: string, since?: Date): Promise<FetchResult<RawEntry>>;
  fetchReceipts(externalClientId: string, since?: Date): Promise<FetchResult<RawReceipt>>;
  fetchMatchings(externalClientId: string): Promise<FetchResult<RawMatching>>;
}
```

- [ ] **Step 2: Type-check**

Run from `server/`: `npx tsc --noEmit -p .`
Expected: Exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/adapters/vendor-adapter.ts
git commit -m "feat(server): define VendorAdapter interface"
```

---

## Task 8: Implement `freee-mock` adapter with fixed data

**Files:**
- Create: `server/src/adapters/freee-mock.ts`
- Create: `server/tests/adapters/freee-mock.test.ts`

- [ ] **Step 1: Write `server/tests/adapters/freee-mock.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { freeeMockAdapter } from '../../src/adapters/freee-mock.js';

describe('freeeMockAdapter', () => {
  it('reports source as freee', () => {
    expect(freeeMockAdapter.source).toBe('freee');
  });

  it('returns at least one entry per known external id', async () => {
    const result = await freeeMockAdapter.fetchEntries('mock-aoyama');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].sourceEntryId).toMatch(/^freee-/);
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it('returns empty arrays for unknown external id', async () => {
    const entries = await freeeMockAdapter.fetchEntries('unknown');
    const receipts = await freeeMockAdapter.fetchReceipts('unknown');
    const matchings = await freeeMockAdapter.fetchMatchings('unknown');
    expect(entries.items).toEqual([]);
    expect(receipts.items).toEqual([]);
    expect(matchings.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/adapters/freee-mock.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/freee-mock.js'`

- [ ] **Step 3: Create `server/src/adapters/freee-mock.ts`**

```ts
import type {
  FetchResult,
  RawEntry,
  RawMatching,
  RawReceipt,
  VendorAdapter,
} from './vendor-adapter.js';

const fixtures: Record<
  string,
  { entries: RawEntry[]; receipts: RawReceipt[]; matchings: RawMatching[] }
> = {
  'mock-aoyama': {
    entries: [
      {
        sourceEntryId: 'freee-aoyama-1',
        account: '広告宣伝費',
        description: 'Meta広告 220,000円',
        amount: 220000,
        taxClass: '課税仕入10%',
        occurredAt: new Date('2026-04-12'),
        receiptStatus: 'missing',
      },
      {
        sourceEntryId: 'freee-aoyama-2',
        account: '消耗品費',
        description: 'PC周辺機器 42,800円',
        amount: 42800,
        taxClass: '課税仕入10%',
        occurredAt: new Date('2026-04-15'),
        receiptStatus: 'matched',
      },
    ],
    receipts: [
      {
        sourceReceiptId: 'freee-rec-aoyama-1',
        status: 'attached',
        vendorRef: 'Adobe',
        amount: 8000,
        occurredAt: new Date('2026-04-10'),
      },
    ],
    matchings: [
      {
        invoiceRef: 'INV-0421',
        invoiceAmount: 330000,
        paidAmount: 326700,
        diffNote: '振込手数料候補',
        status: 'open',
        occurredAt: new Date('2026-04-30'),
      },
    ],
  },
};

function pick<T>(externalId: string, key: 'entries' | 'receipts' | 'matchings'): T[] {
  const f = fixtures[externalId];
  if (!f) return [];
  return f[key] as unknown as T[];
}

export const freeeMockAdapter: VendorAdapter = {
  source: 'freee',
  async fetchEntries(externalId): Promise<FetchResult<RawEntry>> {
    return { items: pick<RawEntry>(externalId, 'entries'), fetchedAt: new Date() };
  },
  async fetchReceipts(externalId): Promise<FetchResult<RawReceipt>> {
    return { items: pick<RawReceipt>(externalId, 'receipts'), fetchedAt: new Date() };
  },
  async fetchMatchings(externalId): Promise<FetchResult<RawMatching>> {
    return { items: pick<RawMatching>(externalId, 'matchings'), fetchedAt: new Date() };
  },
};
```

- [ ] **Step 4: Re-run the test to confirm it passes**

Run from `server/`: `npx vitest run tests/adapters/freee-mock.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/freee-mock.ts server/tests/adapters/freee-mock.test.ts
git commit -m "feat(server): add freee mock adapter"
```

---

## Task 9: MF API adapter stub (OAuth scaffold; no real call)

**Files:**
- Create: `server/src/adapters/mf-api.ts`
- Create: `server/tests/adapters/mf-api.test.ts`

This task only stubs the `VendorAdapter` for MF and provides the OAuth URL builder. Real HTTP calls and token persistence land in spec 01.

- [ ] **Step 1: Write `server/tests/adapters/mf-api.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mfApiAdapter, buildMfAuthorizeUrl } from '../../src/adapters/mf-api.js';

describe('mfApiAdapter', () => {
  it('reports source as mf', () => {
    expect(mfApiAdapter.source).toBe('mf');
  });

  it('returns empty arrays in the stub implementation', async () => {
    const r = await mfApiAdapter.fetchEntries('any');
    expect(r.items).toEqual([]);
  });
});

describe('buildMfAuthorizeUrl', () => {
  it('embeds clientId, redirectUri, and state', () => {
    const url = buildMfAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:3000/cb',
      state: 'st-1',
      scope: 'mfc/invoice/data.read',
    });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb');
    expect(url).toContain('state=st-1');
    expect(url).toContain('scope=mfc%2Finvoice%2Fdata.read');
    expect(url).toContain('response_type=code');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/adapters/mf-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/mf-api.js'`

- [ ] **Step 3: Create `server/src/adapters/mf-api.ts`**

```ts
import type {
  FetchResult,
  RawEntry,
  RawMatching,
  RawReceipt,
  VendorAdapter,
} from './vendor-adapter.js';
import { env } from '../env.js';

interface AuthorizeOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
}

export function buildMfAuthorizeUrl(opts: AuthorizeOptions): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scope,
    response_type: 'code',
  });
  const base = env.MF_BASE_URL || 'https://api.biz.moneyforward.com';
  return `${base}/authorize?${params.toString()}`;
}

const empty = <T>(): FetchResult<T> => ({ items: [], fetchedAt: new Date() });

export const mfApiAdapter: VendorAdapter = {
  source: 'mf',
  async fetchEntries(_id): Promise<FetchResult<RawEntry>> {
    // Real HTTP call lands in spec 01. Returning empty keeps the SWR shell honest.
    return empty<RawEntry>();
  },
  async fetchReceipts(_id): Promise<FetchResult<RawReceipt>> {
    return empty<RawReceipt>();
  },
  async fetchMatchings(_id): Promise<FetchResult<RawMatching>> {
    return empty<RawMatching>();
  },
};
```

- [ ] **Step 4: Re-run the test to confirm it passes**

Run from `server/`: `npx vitest run tests/adapters/mf-api.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/mf-api.ts server/tests/adapters/mf-api.test.ts
git commit -m "feat(server): add MF API adapter stub and OAuth URL builder"
```

---

## Task 10: `seed.ts` — port `script.js` mock data into the DB

**Files:**
- Create: `server/prisma/seed.ts`

This task ports the existing `clients[]` array from `script.js` into Prisma upserts so the dev DB has the same companies the prototype shows. Only the **first three companies** from `script.js` are ported here (青山デザイン, 渋谷カフェ, 中野工務店) — that's enough to drive the foundation. Later specs may add more fixture data.

- [ ] **Step 1: Read `script.js` lines 8–199 to confirm the fixture shape**

(Engineer task: open `/home/kkouta/poc/zeimee/script.js` and skim the `clients` array. Do not change anything in `script.js` yet.)

- [ ] **Step 2: Create `server/prisma/seed.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedClient {
  externalKey: string;          // used to keep upsert idempotent
  name: string;
  industry: string;
  vendor: 'freee' | 'mf' | 'both';
  ownerLabel: string;
  progress: number;
  tasksOpen: number;
  risk: number;
  receipt: number;
  missing: number;
  diff: number;
  matches: number;
  chatMessage: string;
  messageDraft: string;
  contactPrimary: 'email' | 'slack' | 'chatwork' | 'line_works';
  contactEndpoints: Record<string, string | null>;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  rules: { title: string; severity: 'high' | 'mid' | 'low' }[];
  entries: {
    account: string;
    description: string;
    amount: number;
    taxClass: string;
    note: string;
    status: 'urgent' | 'open' | 'done';
    score: number;
  }[];
  receipts: {
    vendorRef: string;
    status: 'attached' | 'missing' | 'candidate';
    note: string;
    score: number;
  }[];
  matchings: {
    invoiceRef: string;
    invoiceAmount: number;
    paidAmount: number;
    diffNote: string;
    status: 'matched' | 'open' | 'urgent' | 'done';
    score: number;
  }[];
  monthlyChecks: { title: string; note: string; detail: string; status: string; score: number }[];
  trendData: { account: string; prev3: number[]; curr: number; changePct: number; flag: 'ok' | 'alert' }[];
  tasks: { title: string; note: string; category: string; status: string; score: number }[];
  vendor_source: 'freee' | 'mf';
}

const seedData: SeedClient[] = [
  {
    externalKey: 'aoyama-design',
    name: '青山デザイン株式会社',
    industry: '広告制作',
    vendor: 'mf',
    ownerLabel: '担当: 鈴木 / 締切 5月10日',
    progress: 87,
    tasksOpen: 6,
    risk: 2,
    receipt: 91,
    missing: 3,
    diff: 2,
    matches: 24,
    chatMessage:
      '青山デザインは今月も順調ですね！広告費の消費税区分だけ先方に確認を取れば、ほぼクローズできそうです。カード明細の証憑も早めに催促しましょう。',
    messageDraft:
      '青山デザイン株式会社 ご担当者様\n\n5月月次確認のため、以下の資料をご共有ください。\n・4月分カード明細に紐づく領収書3件\n・請求INV-0421の入金差額に関する補足\n\n確認後、月次処理を進めます。よろしくお願いいたします。',
    contactPrimary: 'email',
    contactEndpoints: { email: 'aoyama@example.com', slack: null, chatwork: null, line_works: null },
    fiscalYearStart: new Date('2025-04-01'),
    fiscalYearEnd: new Date('2026-03-31'),
    vendor_source: 'mf',
    rules: [
      { title: '広告費は過去6回の消費税区分を優先', severity: 'mid' },
      { title: '資産計上・少額減価償却資産の判定候補を検出', severity: 'mid' },
      { title: '役員名義カードは証憑必須', severity: 'high' },
    ],
    entries: [
      { account: '広告宣伝費', description: 'Meta広告 220,000円', amount: 220000, taxClass: '課税仕入10%', note: '前月は対象外', status: 'urgent', score: 82 },
      { account: '旅費交通費', description: '新幹線 EX予約 18,420円', amount: 18420, taxClass: '課税仕入10%', note: '証憑一致', status: 'done', score: 94 },
      { account: '外注費', description: '個人デザイナー 385,000円', amount: 385000, taxClass: '源泉確認', note: '摘要に個人名', status: 'open', score: 69 },
      { account: '消耗品費', description: 'PC周辺機器 42,800円', amount: 42800, taxClass: '課税仕入10%', note: '過去処理一致', status: 'done', score: 96 },
    ],
    receipts: [
      { vendorRef: 'カード明細 4/12', status: 'missing', note: '顧問先依頼待ち', score: 76 },
      { vendorRef: 'EX予約', status: 'attached', note: '自動紐付け可能', score: 94 },
      { vendorRef: 'Adobe', status: 'attached', note: '取引に紐付け済み', score: 98 },
      { vendorRef: '備品購入', status: 'candidate', note: '金額一致、日付差異', score: 72 },
    ],
    matchings: [
      { invoiceRef: 'INV-0421', invoiceAmount: 330000, paidAmount: 326700, diffNote: '振込手数料候補', status: 'open', score: 88 },
      { invoiceRef: 'INV-0422', invoiceAmount: 550000, paidAmount: 550000, diffNote: '完全一致', status: 'done', score: 99 },
      { invoiceRef: 'INV-0425', invoiceAmount: 198000, paidAmount: 0, diffNote: '未入金', status: 'urgent', score: 61 },
    ],
    monthlyChecks: [
      { title: '売掛金残高', note: '前月比 +32%', detail: '増加率が高い', status: 'open', score: 71 },
      { title: '預金残高', note: '帳簿残高と銀行明細を照合', detail: '月末残高一致', status: 'done', score: 97 },
      { title: '仮払金', note: '前月から繰越 2件', detail: '内容確認が必要', status: 'open', score: 74 },
      { title: '役員貸付金', note: '変動なし', detail: '問題なし', status: 'done', score: 96 },
      { title: '外注費', note: '源泉対象候補あり', detail: '確認が必要', status: 'urgent', score: 69 },
    ],
    trendData: [
      { account: '売上高', prev3: [4200000, 4800000, 5100000], curr: 5400000, changePct: 5.9, flag: 'ok' },
      { account: '広告宣伝費', prev3: [180000, 195000, 210000], curr: 350000, changePct: 66.7, flag: 'alert' },
      { account: '外注費', prev3: [280000, 310000, 290000], curr: 385000, changePct: 32.8, flag: 'alert' },
      { account: '売掛金', prev3: [1200000, 1350000, 1420000], curr: 1880000, changePct: 32.4, flag: 'alert' },
      { account: '旅費交通費', prev3: [42000, 38000, 45000], curr: 48000, changePct: 6.7, flag: 'ok' },
      { account: '消耗品費', prev3: [32000, 28000, 35000], curr: 43000, changePct: 22.9, flag: 'ok' },
    ],
    tasks: [
      { title: '広告費 220,000円の消費税区分を確認', note: '過去ルールと異なる候補を検出', category: 'AI仕訳候補', status: 'urgent', score: 82 },
      { title: '4月分カード明細の証憑が不足', note: '顧問先への依頼文を作成済み', category: '証憑', status: 'urgent', score: 76 },
      { title: '請求INV-0421と入金額に差異', note: '振込手数料の可能性あり', category: '消込', status: 'open', score: 88 },
      { title: '外注費 385,000円の源泉対象確認', note: '摘要に個人名を検出', category: '月次チェック', status: 'open', score: 69 },
      { title: '旅費交通費の領収書候補を承認', note: 'Drive内に一致候補あり', category: '証憑', status: 'done', score: 93 },
      { title: '売掛金残高の前月差異確認', note: '増加率がルール閾値を超過', category: '月次チェック', status: 'open', score: 71 },
    ],
  },
];

async function run() {
  // Receipt policies (global defaults)
  const policies = [
    { account: '広告宣伝費', requiresReceipt: true, requiresApproval: false },
    { account: '旅費交通費', requiresReceipt: true, requiresApproval: false, exemptUnder: 3000 },
    { account: '消耗品費', requiresReceipt: true, requiresApproval: false },
    { account: '通信費', requiresReceipt: false, requiresApproval: false },
    { account: '外注費', requiresReceipt: true, requiresApproval: true, notes: '源泉対象判定が必要' },
    { account: '会議費', requiresReceipt: true, requiresApproval: false },
    { account: '租税公課', requiresReceipt: false, requiresApproval: false },
  ];
  for (const p of policies) {
    await prisma.receiptPolicy.upsert({
      where: { account: p.account },
      create: p,
      update: p,
    });
  }

  for (const c of seedData) {
    const client = await prisma.client.upsert({
      where: { id: c.externalKey },
      update: {
        name: c.name, industry: c.industry, vendor: c.vendor,
        ownerLabel: c.ownerLabel, progress: c.progress, tasksOpen: c.tasksOpen,
        risk: c.risk, receipt: c.receipt, missing: c.missing, diff: c.diff, matches: c.matches,
        chatMessage: c.chatMessage, messageDraft: c.messageDraft,
        contactPrimary: c.contactPrimary, contactEndpoints: c.contactEndpoints,
        fiscalYearStart: c.fiscalYearStart, fiscalYearEnd: c.fiscalYearEnd,
      },
      create: {
        id: c.externalKey,
        name: c.name, industry: c.industry, vendor: c.vendor,
        ownerLabel: c.ownerLabel, progress: c.progress, tasksOpen: c.tasksOpen,
        risk: c.risk, receipt: c.receipt, missing: c.missing, diff: c.diff, matches: c.matches,
        chatMessage: c.chatMessage, messageDraft: c.messageDraft,
        contactPrimary: c.contactPrimary, contactEndpoints: c.contactEndpoints,
        fiscalYearStart: c.fiscalYearStart, fiscalYearEnd: c.fiscalYearEnd,
      },
    });

    // Replace child collections to keep seed idempotent
    await prisma.entry.deleteMany({ where: { clientId: client.id } });
    await prisma.receipt.deleteMany({ where: { clientId: client.id } });
    await prisma.matching.deleteMany({ where: { clientId: client.id } });
    await prisma.monthlyCheck.deleteMany({ where: { clientId: client.id } });
    await prisma.trendDatum.deleteMany({ where: { clientId: client.id } });
    await prisma.task.deleteMany({ where: { clientId: client.id } });
    await prisma.rule.deleteMany({ where: { clientId: client.id } });
    await prisma.vendorSync.deleteMany({ where: { clientId: client.id } });

    let entryIdx = 0;
    for (const e of c.entries) {
      entryIdx += 1;
      await prisma.entry.create({
        data: {
          clientId: client.id,
          source: c.vendor_source,
          sourceEntryId: `seed-${c.externalKey}-entry-${entryIdx}`,
          account: e.account,
          description: e.description,
          amount: e.amount,
          taxClass: e.taxClass,
          occurredAt: new Date('2026-04-15'),
          receiptStatus: e.status === 'urgent' ? 'missing' : e.status === 'done' ? 'matched' : 'partial',
          score: e.score,
        },
      });
    }

    let recIdx = 0;
    for (const r of c.receipts) {
      recIdx += 1;
      await prisma.receipt.create({
        data: {
          clientId: client.id,
          source: c.vendor_source,
          sourceReceiptId: `seed-${c.externalKey}-rec-${recIdx}`,
          status: r.status,
          vendorRef: r.vendorRef,
          occurredAt: new Date('2026-04-15'),
        },
      });
    }

    let matIdx = 0;
    for (const m of c.matchings) {
      matIdx += 1;
      await prisma.matching.create({
        data: {
          clientId: client.id,
          source: c.vendor_source,
          invoiceRef: m.invoiceRef,
          invoiceAmount: m.invoiceAmount,
          paidAmount: m.paidAmount,
          diffNote: m.diffNote,
          status: m.status,
          occurredAt: new Date('2026-04-30'),
        },
      });
    }

    for (const mc of c.monthlyChecks) {
      await prisma.monthlyCheck.create({
        data: {
          clientId: client.id,
          title: mc.title,
          note: mc.note,
          detail: mc.detail,
          status: mc.status,
          score: mc.score,
        },
      });
    }

    for (const t of c.trendData) {
      await prisma.trendDatum.create({
        data: {
          clientId: client.id,
          account: t.account,
          prev3: t.prev3,
          curr: t.curr,
          changePct: t.changePct,
          flag: t.flag,
        },
      });
    }

    for (const ru of c.rules) {
      await prisma.rule.create({
        data: {
          clientId: client.id,
          type: 'template',
          industry: c.industry,
          title: ru.title,
          severity: ru.severity,
          createdBy: 'seed',
        },
      });
    }

    for (const tk of c.tasks) {
      await prisma.task.create({
        data: {
          clientId: client.id,
          title: tk.title,
          note: tk.note,
          category: tk.category,
          status: tk.status,
          score: tk.score,
          stage: tk.status === 'done' ? 'approved' : 'awaiting_approval',
          assignee: c.ownerLabel.split(' / ')[0].replace('担当: ', ''),
          approver: '畠山',
        },
      });
    }

    await prisma.vendorSync.create({
      data: {
        clientId: client.id,
        vendor: c.vendor_source,
        lastSync: new Date(),
        status: 'ok',
        count: c.entries.length,
      },
    });
  }

  console.log(`Seed complete. clients=${seedData.length}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

> Note: Only one client (`aoyama-design`) is seeded here. After Task 11 verifies end-to-end flow, more companies can be appended in a follow-up commit. The seed must remain idempotent (re-running gives the same DB state).

- [ ] **Step 3: Run the seed**

Run from `server/`: `npm run seed`
Expected: console prints `Seed complete. clients=1`. No errors.

- [ ] **Step 4: Verify the data via psql**

Run from repo root:
```bash
docker compose exec postgres psql -U zeimee -d zeimee -c 'SELECT id, name, vendor FROM "Client";'
```
Expected: row with `aoyama-design | 青山デザイン株式会社 | mf`.

- [ ] **Step 5: Re-run the seed to verify idempotency**

Run from `server/`: `npm run seed`
Expected: Same output, no duplicate-key errors.

- [ ] **Step 6: Commit**

```bash
git add server/prisma/seed.ts
git commit -m "feat(server): seed first client (青山デザイン) into Postgres"
```

---

## Task 11: `client-service` and `GET /api/clients`

**Files:**
- Create: `server/src/services/client-service.ts`
- Create: `server/src/routes/clients.ts`
- Create: `server/tests/services/client-service.test.ts`
- Create: `server/tests/routes/clients.test.ts`
- Modify: `server/src/server.ts` (register the new route)

> The DB tests assume the dev DB seeded by Task 10 is reachable. Tests do **not** mutate data — they only query.

- [ ] **Step 1: Write `server/tests/services/client-service.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { listClients } from '../../src/services/client-service.js';
import { prisma } from '../../src/lib/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('listClients', () => {
  it('returns the seeded client with summary fields', async () => {
    const rows = await listClients();
    const aoyama = rows.find((r) => r.id === 'aoyama-design');
    expect(aoyama).toBeDefined();
    expect(aoyama!.vendor).toBe('mf');
    expect(aoyama!.progress).toBe(87);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/services/client-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/services/client-service.ts`**

```ts
import { prisma } from '../lib/prisma.js';

export async function listClients() {
  return prisma.client.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      industry: true,
      vendor: true,
      mode: true,
      ownerLabel: true,
      progress: true,
      tasksOpen: true,
      risk: true,
      receipt: true,
      missing: true,
      diff: true,
      matches: true,
      chatMessage: true,
      messageDraft: true,
      contactPrimary: true,
      contactEndpoints: true,
    },
  });
}

export async function getClientById(id: string) {
  return prisma.client.findUnique({
    where: { id },
    include: {
      entries: { orderBy: { occurredAt: 'desc' } },
      receipts: { orderBy: { occurredAt: 'desc' } },
      matchings: { orderBy: { occurredAt: 'desc' } },
      monthlyChecks: true,
      trendData: true,
      rules: true,
      tasks: { orderBy: { score: 'desc' } },
      vendorSyncs: true,
    },
  });
}
```

- [ ] **Step 4: Re-run the service test to confirm it passes**

Run from `server/`: `npx vitest run tests/services/client-service.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Write `server/tests/routes/clients.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/clients', () => {
  it('returns an array including the seeded aoyama client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const aoyama = body.find((c: any) => c.id === 'aoyama-design');
    expect(aoyama).toBeDefined();
    expect(aoyama.name).toBe('青山デザイン株式会社');
  });
});
```

- [ ] **Step 6: Create `server/src/routes/clients.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { listClients, getClientById } from '../services/client-service.js';

export async function clientRoutes(app: FastifyInstance) {
  app.get('/api/clients', async () => {
    return listClients();
  });

  app.get<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
    const client = await getClientById(req.params.id);
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return client;
  });
}
```

- [ ] **Step 7: Register the route in `server/src/server.ts`**

Modify `server/src/server.ts`. Add an import and a `register` call:

```ts
// at the top, alongside existing imports
import { clientRoutes } from './routes/clients.js';

// inside buildApp(), after registering healthRoutes:
await app.register(clientRoutes);
```

- [ ] **Step 8: Run the route test to confirm it passes**

Run from `server/`: `npx vitest run tests/routes/clients.test.ts`
Expected: 1 passing.

- [ ] **Step 9: Run the full test suite**

Run from `server/`: `npm test`
Expected: All previous tests still pass.

- [ ] **Step 10: Smoke check via curl**

Run from `server/`: `npm run dev` (background). In another shell:
```bash
curl -s http://localhost:3000/api/clients | jq '.[0] | {id, name, vendor}'
```
Expected: `{ "id": "aoyama-design", "name": "青山デザイン株式会社", "vendor": "mf" }`. Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add server/src/services/client-service.ts server/src/routes/clients.ts server/src/server.ts server/tests/services/client-service.test.ts server/tests/routes/clients.test.ts
git commit -m "feat(server): add /api/clients listing and detail endpoints"
```

---

## Task 12: `GET /api/clients/:id` integration test

**Files:**
- Modify: `server/tests/routes/clients.test.ts`

The detail endpoint already exists from Task 11. This task adds a dedicated test so regressions are caught.

- [ ] **Step 1: Append to `server/tests/routes/clients.test.ts`**

```ts
describe('GET /api/clients/:id', () => {
  it('returns a 404 for unknown ids with friendly error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'client not found' } });
  });

  it('returns the seeded client with nested entries, receipts, tasks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/aoyama-design' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('aoyama-design');
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.receipts.length).toBeGreaterThan(0);
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.tasks[0].stage).toBe('awaiting_approval');
  });
});
```

- [ ] **Step 2: Run the test**

Run from `server/`: `npx vitest run tests/routes/clients.test.ts`
Expected: 3 passing (1 from Task 11 + 2 new).

- [ ] **Step 3: Commit**

```bash
git add server/tests/routes/clients.test.ts
git commit -m "test(server): cover /api/clients/:id detail and 404 path"
```

---

## Task 13: `sync-service` SWR shell + `POST /api/clients/:id/sync`

**Files:**
- Create: `server/src/services/sync-service.ts`
- Create: `server/src/routes/sync.ts`
- Create: `server/tests/services/sync-service.test.ts`
- Create: `server/tests/routes/sync.test.ts`
- Modify: `server/src/server.ts`

This task wires the Stale-While-Revalidate shell. With the MF adapter currently a stub (Task 9), the only side effect of a sync is updating the `VendorSync.lastSync` row. That's enough to prove the shell works; spec 01 will hook in real fetches.

- [ ] **Step 1: Write `server/tests/services/sync-service.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { syncClient, isStale } from '../../src/services/sync-service.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('isStale', () => {
  it('returns true when lastSync is null', () => {
    expect(isStale(null, 60)).toBe(true);
  });
  it('returns true when lastSync is older than threshold', () => {
    const old = new Date(Date.now() - 120_000);
    expect(isStale(old, 60)).toBe(true);
  });
  it('returns false when lastSync is fresh', () => {
    const recent = new Date(Date.now() - 1000);
    expect(isStale(recent, 60)).toBe(false);
  });
});

describe('syncClient', () => {
  it('updates VendorSync.lastSync for the seeded client', async () => {
    const before = await prisma.vendorSync.findFirst({ where: { clientId: 'aoyama-design' } });
    const result = await syncClient('aoyama-design');
    expect(result.status).toBe('ok');
    const after = await prisma.vendorSync.findFirst({ where: { clientId: 'aoyama-design' } });
    expect(after?.lastSync?.getTime()).toBeGreaterThan(before?.lastSync?.getTime() ?? 0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `server/`: `npx vitest run tests/services/sync-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/services/sync-service.ts`**

```ts
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { freeeMockAdapter } from '../adapters/freee-mock.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import type { VendorAdapter, VendorSource } from '../adapters/vendor-adapter.js';
import { env } from '../env.js';

const adapters: Record<VendorSource, VendorAdapter> = {
  mf: mfApiAdapter,
  freee: freeeMockAdapter,
};

export function isStale(lastSync: Date | null, thresholdSec: number): boolean {
  if (!lastSync) return true;
  const ageMs = Date.now() - lastSync.getTime();
  return ageMs > thresholdSec * 1000;
}

export interface SyncResult {
  clientId: string;
  vendor: VendorSource;
  status: 'ok' | 'error';
  count: number;
  errorMsg?: string;
}

export async function syncClient(clientId: string): Promise<SyncResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    return { clientId, vendor: 'mf', status: 'error', count: 0, errorMsg: 'client not found' };
  }
  const vendor: VendorSource = client.vendor === 'freee' ? 'freee' : 'mf';
  const adapter = adapters[vendor];
  const externalId = client.mfExternalId ?? `mock-${client.id}`;

  try {
    const [entries, receipts, matchings] = await Promise.all([
      adapter.fetchEntries(externalId),
      adapter.fetchReceipts(externalId),
      adapter.fetchMatchings(externalId),
    ]);
    const total = entries.items.length + receipts.items.length + matchings.items.length;
    await prisma.vendorSync.upsert({
      where: { clientId_vendor: { clientId: client.id, vendor } },
      update: { lastSync: new Date(), status: 'ok', count: total, errorMsg: null },
      create: { clientId: client.id, vendor, lastSync: new Date(), status: 'ok', count: total },
    });
    logger.info({ clientId, vendor, total }, 'sync ok');
    return { clientId, vendor, status: 'ok', count: total };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await prisma.vendorSync.upsert({
      where: { clientId_vendor: { clientId: client.id, vendor } },
      update: { status: 'error', errorMsg },
      create: { clientId: client.id, vendor, status: 'error', errorMsg, count: 0 },
    });
    logger.error({ clientId, vendor, errorMsg }, 'sync failed');
    return { clientId, vendor, status: 'error', count: 0, errorMsg };
  }
}

export function revalidateInBackground(clientId: string): void {
  // Fire-and-forget. BullMQ/Redis job lands in spec 03 work.
  void syncClient(clientId).catch((err) => {
    logger.error({ err, clientId }, 'background revalidate failed');
  });
}

export const STALE_SEC = env.STALE_THRESHOLD_SEC;
export const MAX_AGE_SEC = env.MAX_AGE_SEC;
```

- [ ] **Step 4: Re-run the service test to confirm it passes**

Run from `server/`: `npx vitest run tests/services/sync-service.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Write `server/tests/routes/sync.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('POST /api/clients/:id/sync', () => {
  it('returns ok status for the seeded client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/clients/aoyama-design/sync' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.vendor).toBe('mf');
  });

  it('returns 404 for unknown clients', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/clients/missing/sync' });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 6: Create `server/src/routes/sync.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { syncClient } from '../services/sync-service.js';

export async function syncRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/clients/:id/sync', async (req, reply) => {
    const result = await syncClient(req.params.id);
    if (result.status === 'error' && result.errorMsg === 'client not found') {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return result;
  });
}
```

- [ ] **Step 7: Register the route in `server/src/server.ts`**

Modify `server/src/server.ts`. Add:

```ts
import { syncRoutes } from './routes/sync.js';
// inside buildApp(), after clientRoutes register:
await app.register(syncRoutes);
```

- [ ] **Step 8: Run the route test to confirm it passes**

Run from `server/`: `npx vitest run tests/routes/sync.test.ts`
Expected: 2 passing.

- [ ] **Step 9: Run the full test suite**

Run from `server/`: `npm test`
Expected: All passing.

- [ ] **Step 10: Commit**

```bash
git add server/src/services/sync-service.ts server/src/routes/sync.ts server/src/server.ts server/tests/services/sync-service.test.ts server/tests/routes/sync.test.ts
git commit -m "feat(server): add SWR sync-service and POST /api/clients/:id/sync"
```

---

## Task 14: Notification adapter interface (stubs only)

**Files:**
- Create: `server/src/adapters/notification.ts`

This task only declares the contract. Real adapters (SendGrid, Slack, Chatwork, LINE WORKS) come in spec 03. Defining the interface now gives `Thread`-related work a typed surface.

- [ ] **Step 1: Create `server/src/adapters/notification.ts`**

```ts
export type Channel = 'email' | 'slack' | 'chatwork' | 'line_works' | 'messenger';

export interface SendPayload {
  subject?: string;
  body: string;
  raw?: unknown;
}

export interface SendResult {
  externalId?: string;
}

export interface NotificationAdapter {
  readonly channel: Channel;
  send(endpoint: string, payload: SendPayload): Promise<SendResult>;
}

export class NotImplementedNotificationAdapter implements NotificationAdapter {
  constructor(public readonly channel: Channel) {}
  async send(): Promise<SendResult> {
    throw new Error(
      `Notification adapter for channel "${this.channel}" not implemented yet (see spec 03)`,
    );
  }
}

export function getDefaultAdapters(): Record<Channel, NotificationAdapter> {
  return {
    email: new NotImplementedNotificationAdapter('email'),
    slack: new NotImplementedNotificationAdapter('slack'),
    chatwork: new NotImplementedNotificationAdapter('chatwork'),
    line_works: new NotImplementedNotificationAdapter('line_works'),
    messenger: new NotImplementedNotificationAdapter('messenger'),
  };
}
```

- [ ] **Step 2: Type-check**

Run from `server/`: `npx tsc --noEmit -p .`
Expected: Exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/adapters/notification.ts
git commit -m "feat(server): declare NotificationAdapter contract (stubs)"
```

---

## Task 15: Serve the existing frontend statically from Fastify

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Edit `server/src/server.ts`**

Add an import and a `register` call to serve the repo-root frontend files. Add this **after** the `cors` register and **before** the route registers:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import staticPlugin from '@fastify/static';

// inside buildApp():
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
await app.register(staticPlugin, {
  root: repoRoot,
  prefix: '/',
  index: ['index.html'],
  decorateReply: false,
});
```

The `root` resolves to `/home/kkouta/poc/zeimee` (server/src/.. = server, /.. = repo root). The frontend keeps its existing relative paths (`./styles.css`, `./script.js`).

- [ ] **Step 2: Smoke test in a browser**

Run from `server/`: `npm run dev`
Open `http://localhost:3000/` in a browser.
Expected: The current Zeimee UI loads (sidebar, summary cards, etc.). It still uses the inline `clients[]` array — that gets replaced in Task 16.
Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): serve existing frontend via @fastify/static"
```

---

## Task 16: Refactor `script.js` to load clients via `fetch('/api/clients')`

**Files:**
- Modify: `script.js` (repo root)

The existing `script.js` defines `const clients = [...]` inline (lines 8–199). This task replaces it with a runtime fetch. All other render functions stay the same — they read from a module-level `clients` variable.

- [ ] **Step 1: Read `script.js` lines 1–10 and 199–260 to confirm where the array starts and ends**

(Engineer: `head -260 script.js` and locate the closing `];` of the `clients` array.)

- [ ] **Step 2: Modify the top of `script.js`**

Replace `const clients = [...]` with `let clients = []` and add an `init()` that loads data before the first render. The first render call at the bottom (`render();`) must wait for the fetch.

Concretely:

a. Change line 8 (`const clients = [`) to `let clients = [`.
b. Leave the array contents in place as a fallback (so the page shows something if the API isn't available yet).
c. Add a new helper near the top (right after `appState`):

```js
async function loadClientsFromApi() {
  try {
    const res = await fetch('/api/clients');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const remote = await res.json();
    if (Array.isArray(remote) && remote.length > 0) {
      clients = remote.map(adaptApiClient);
    }
  } catch (err) {
    console.warn('Failed to load clients from API; using inline fallback', err);
  }
}

function adaptApiClient(api) {
  // Map API shape (Task 11 selection) onto the legacy fields the render functions read.
  return {
    name: api.name,
    owner: api.ownerLabel ?? '',
    progress: api.progress,
    tasksOpen: api.tasksOpen,
    risk: api.risk,
    receipt: api.receipt,
    missing: api.missing,
    diff: api.diff,
    matches: api.matches,
    chatMessage: api.chatMessage ?? '',
    rules: [],            // populated when /api/clients/:id is fetched in render flow
    message: api.messageDraft ?? '',
    tasks: [],
    entries: [],
    receipts: [],
    matching: [],
    checks: [],
    trendData: [],
  };
}
```

d. Replace the final `render();` call at the bottom of the file with:

```js
loadClientsFromApi().finally(render);
```

- [ ] **Step 3: Smoke test in the browser**

Run from `server/`: `npm run dev`
Open `http://localhost:3000/`.
Expected: The page loads; the customer strip shows `青山デザイン株式会社` (from the DB). Other panels may show empty states because the detail endpoint isn't wired into the render loop yet — that's expected for this foundation plan and is addressed in spec 01's PR.
Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add script.js
git commit -m "feat(frontend): load clients via fetch('/api/clients') with inline fallback"
```

---

## Task 17: Root `README.md` with run instructions

**Files:**
- Modify: `README.md` (repo root)

- [ ] **Step 1: Replace `README.md` content**

```markdown
# Zeimee

税理士事務所向け AI 月次レビュー SaaS のプロトタイプ。

## 開発環境セットアップ

### 必要なもの
- Node.js 20+
- Docker Desktop（または互換のCompose対応ランタイム）
- npm

### 初回セットアップ
```bash
# 1. Postgres を起動
docker compose up -d postgres

# 2. サーバー依存をインストール
cd server
npm install

# 3. 環境変数を用意
cp .env.example .env

# 4. DBマイグレーションとシード
npm run prisma:migrate
npm run seed
```

### 開発サーバー起動
```bash
cd server
npm run dev
```
ブラウザで http://localhost:3000/ を開く。

### テスト
```bash
cd server
npm test
```

## 構成
- フロントエンド: ルートの `index.html` / `styles.css` / `script.js`（Vanilla JS）
- バックエンド: `server/`（Node.js + TypeScript + Fastify + Prisma）
- DB: PostgreSQL 16（Docker Compose）

## 設計ドキュメント
`docs/superpowers/specs/` に各機能の設計書、`docs/superpowers/plans/` に実装プラン。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: replace README with run instructions"
```

---

## Task 18: End-to-end smoke test

**Files:**
- (no new files; this is a validation task that confirms the foundation works)

- [ ] **Step 1: Reset the DB**

Run from repo root:
```bash
docker compose down -v
docker compose up -d postgres
```
Wait ~5 seconds for Postgres to start. Then from `server/`:
```bash
npm run prisma:migrate
npm run seed
```
Expected: Migration applies cleanly from scratch; seed completes with `Seed complete. clients=1`.

- [ ] **Step 2: Run the full test suite**

Run from `server/`: `npm test`
Expected: All test files pass. Note the totals in the output (e.g. `Test Files X passed, Tests Y passed`).

- [ ] **Step 3: Start the dev server**

Run from `server/`: `npm run dev` (background).

- [ ] **Step 4: API smoke checks**

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/clients | jq 'length'
curl -s http://localhost:3000/api/clients/aoyama-design | jq '{id, name, entryCount: (.entries|length), taskCount: (.tasks|length)}'
curl -sX POST http://localhost:3000/api/clients/aoyama-design/sync | jq
```
Expected:
- health: `{"status":"ok",...}`
- clients length: `1`
- detail: `{ "id": "aoyama-design", "name": "青山デザイン株式会社", "entryCount": 4, "taskCount": 6 }` (or similar)
- sync: `{ "clientId": "aoyama-design", "vendor": "mf", "status": "ok", "count": 0 }`

- [ ] **Step 5: Browser smoke check**

Open `http://localhost:3000/` in a browser. Confirm:
- 青山デザイン株式会社 appears in the customer strip
- The dashboard renders without console errors (some panels may be empty; that's expected — wired up in spec 01)
- Stop the dev server.

- [ ] **Step 6: Final commit (only if anything changed in steps 1–5; otherwise skip)**

If no files changed, skip this step. Otherwise:
```bash
git add -A
git commit -m "chore: smoke-test confirms foundation works end-to-end"
```

---

## Self-Review Notes

(Done at plan-write time; recorded here so the executing engineer can confirm.)

**Spec coverage:**
- Stack ✓ (Tasks 1, 2, 4)
- DB schema (every model in spec 09) ✓ Task 4
- env handling ✓ Task 3
- Fastify scaffold + health ✓ Task 6
- VendorAdapter interface ✓ Task 7
- freee-mock ✓ Task 8
- MF OAuth scaffold ✓ Task 9
- seed.ts ✓ Task 10
- /api/clients listing ✓ Task 11
- /api/clients/:id detail ✓ Tasks 11/12
- SWR shell + sync endpoint ✓ Task 13
- Notification adapter contract ✓ Task 14
- Static frontend serving ✓ Task 15
- script.js fetch refactor ✓ Task 16
- README ✓ Task 17

**Deferred to later specs (intentional):**
- Real MF API HTTP calls + token persistence → spec 01
- Real notification send (4 channels) + retries → spec 03
- BullMQ + Redis background jobs → spec 03
- Cross-vendor UI (badges, integration card) → spec 01
- Approval workflow stage transitions → spec 02
- Rules CRUD → spec 04
- Mode toggle → spec 05
- UI labels overhaul → spec 06
- Missing-receipt detection → spec 07
- Vendor jump-link buttons → spec 01 / 08

**Type consistency check:**
- `VendorSource` used identically in `vendor-adapter.ts`, `freee-mock.ts`, `mf-api.ts`, `sync-service.ts`.
- `Channel` used identically in `notification.ts`. No callers yet (lands in spec 03).
- `clientId` typed as `String` (Prisma) and as `req.params.id: string` in routes. ✓

---

Plan complete and saved to `docs/superpowers/plans/2026-05-16-09-system-architecture.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
