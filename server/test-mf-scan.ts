import './src/bootstrap.js';
import { prisma } from './src/lib/prisma.js';
import { request } from 'undici';
import { env } from './src/env.js';

const client = await prisma.client.findFirst({
  where: { name: '株式会社ZetaX' },
  select: { mfAccessToken: true },
});

const token = client!.mfAccessToken!;
const base = env.MF_ACCOUNTING_BASE_URL;

// 直近90日の仕訳を取得
const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
const res = await request(`${base}/api/v3/journals?start_date=${from}&end_date=${today}`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
});
const data = await res.body.json() as { journals?: { transaction_date: string; memo?: string; branches?: { debitor?: { account_name?: string; value: number }; creditor?: { account_name?: string } }[] }[] };
const journals = data.journals ?? [];
console.log(`仕訳件数: ${journals.length}`);
for (const j of journals.slice(0, 10)) {
  const debit = j.branches?.[0]?.debitor;
  const credit = j.branches?.[0]?.creditor;
  console.log(`  ${j.transaction_date} | ${debit?.account_name ?? '?'} ¥${debit?.value} / ${credit?.account_name ?? '?'} | ${j.memo ?? ''}`);
}

await prisma.$disconnect();
