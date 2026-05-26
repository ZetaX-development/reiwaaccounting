import OpenAI from 'openai';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

export interface ReminderDraft {
  subject: string;
  body: string;
}

const SYSTEM_PROMPT = `あなたは税理士事務所のスタッフとして、顧問先への丁寧なリマインドメールを書くアシスタントです。
簡潔で丁寧な日本語ビジネスメールを作成してください。返答は必ず JSON 形式のみで返してください。`;

function buildTargetMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月`;
}

function buildUserPrompt(args: {
  clientName: string;
  targetMonth: string;
  unmatchedCount: number;
  ownerLabel: string | null;
}): string {
  const countDesc =
    args.unmatchedCount > 0
      ? `${args.unmatchedCount} 件の証憑（領収書・請求書等）が未マッチの状態です`
      : `証憑（領収書・請求書等）がまだ届いていない状態です`;

  return `以下の状況に基づき、証憑提出のリマインドメールを作成してください。

顧問先名: ${args.clientName}
対象月: ${args.targetMonth}
状況: ${countDesc}
担当者名: ${args.ownerLabel || ''}

出力形式（JSON のみ、他のテキスト不要）:
{"subject":"件名（50文字以内）","body":"本文（署名含む、300文字程度）"}`;
}

export async function generateReminderDraft(clientId: string): Promise<ReminderDraft | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, ownerLabel: true },
  });
  if (!client) return null;

  const unmatchedCount = await prisma.voucher.count({
    where: { clientId, matchStatus: 'unmatched' },
  });

  const targetMonth = buildTargetMonth();
  const userPrompt = buildUserPrompt({
    clientName: client.name,
    targetMonth,
    unmatchedCount,
    ownerLabel: client.ownerLabel,
  });

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 512,
  });

  const raw = completion.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.trim()) as { subject?: string; body?: string };

  return {
    subject: parsed.subject ?? `[経理丸ごとAI] ${targetMonth}分 証憑のご提出をお願いいたします`,
    body: parsed.body ?? '',
  };
}
