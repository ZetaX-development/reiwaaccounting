/**
 * 納品用デモアカウントを Supabase + demo-firm に紐づけ、シードデータを投入する。
 *
 * Usage (Railway):
 *   railway run npm run setup-delivery-demo
 *
 * Env (optional):
 *   DEMO_EMAIL    default: demo@keiri-marunage.jp
 *   DEMO_PASSWORD default: BookmeeDemo2026!
 */
import '../src/bootstrap.js';
// railway run ローカル実行時: .internal URL は届かないので公開 URL に切り替え
if (
  process.env.DATABASE_URL?.includes('.railway.internal') &&
  process.env.DATABASE_PUBLIC_URL
) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import { env } from '../src/env.js';

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@keiri-marunage.jp';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'BookmeeDemo2026!';

const prisma = new PrismaClient();

async function ensureSupabaseUser(): Promise<string> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    perPage: 1000,
  });
  if (listErr) throw listErr;

  let user = list.users.find(
    (u) => u.email?.toLowerCase() === DEMO_EMAIL.toLowerCase(),
  );

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error('createUser failed');
    user = data.user;
    console.log(`Created Supabase user: ${DEMO_EMAIL}`);
  } else {
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: DEMO_PASSWORD,
    });
    if (error) throw error;
    console.log(`Updated password for existing user: ${DEMO_EMAIL}`);
  }

  return user.id;
}

async function linkDemoFirm(authUserId: string): Promise<void> {
  await prisma.firm.upsert({
    where: { id: 'demo-firm' },
    update: { name: 'bookmee デモ事務所', slug: 'demo', isDemo: true },
    create: {
      id: 'demo-firm',
      name: 'bookmee デモ事務所',
      slug: 'demo',
      isDemo: true,
    },
  });

  await prisma.firmMember.deleteMany({ where: { firmId: 'demo-firm' } });

  await prisma.firmMember.create({
    data: {
      firmId: 'demo-firm',
      authUserId,
      role: 'owner',
      email: DEMO_EMAIL,
      status: 'active',
      joinedAt: new Date(),
    },
  });

  console.log(`Linked ${DEMO_EMAIL} → demo-firm (owner)`);
}

function runSeed(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, '..');
  execSync('npx tsx prisma/seed.ts', {
    cwd: serverRoot,
    stdio: 'inherit',
  });
}

async function main(): Promise<void> {
  const authUserId = await ensureSupabaseUser();
  await linkDemoFirm(authUserId);
  runSeed();
  console.log('\n=== 納品デモアカウント ===');
  console.log(`URL:      https://bookmee-production.up.railway.app/login.html`);
  console.log(`Email:    ${DEMO_EMAIL}`);
  console.log(`Password: ${DEMO_PASSWORD}`);
  console.log('顧問先: 青山デザイン / 渋谷カフェ / 日本橋工業 / 横浜メディカル');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
