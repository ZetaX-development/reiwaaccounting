import { prisma } from '../lib/prisma.js';
import OpenAI from 'openai';

export interface TrainingCard {
  id: string;
  type: 'rule' | 'correction' | 'industry';
  question: string;
  answer: string;
  hint: string;
  difficulty: 'easy' | 'medium' | 'hard';
  clientName?: string;
  industry?: string;
  source: string; // rule id or review id
}

export interface TrainingStats {
  ruleCount: number;
  correctionCount: number;
  cardCount: number;
  lastGeneratedAt: string | null;
}

// Build training cards without OpenAI (template-based)
function buildRuleCard(rule: {
  id: string;
  title: string;
  detail: string;
  industry: string | null;
  severity: string;
  clientId: string;
}, clientName: string): TrainingCard {
  const difficulty = rule.severity === 'high' ? 'hard' : rule.severity === 'mid' ? 'medium' : 'easy';
  return {
    id: `rule-${rule.id}`,
    type: 'rule',
    question: `【確認問題】次のルールについて、どういう場面で適用しますか？\n「${rule.title}」`,
    answer: rule.detail || '詳細はルールの設定を確認してください。',
    hint: `顧問先: ${clientName}${rule.industry ? ` / 業種: ${rule.industry}` : ''}`,
    difficulty,
    clientName,
    industry: rule.industry ?? undefined,
    source: rule.id,
  };
}

function buildCorrectionCard(review: {
  id: string;
  originalMemo: string | null;
  aiMemo: string | null;
  debitAccount: string | null;
  creditAccount: string | null;
  amount: number | null;
  transactionDate: string | null;
  clientId: string;
}, clientName: string): TrainingCard | null {
  if (!review.originalMemo && !review.aiMemo) return null;
  const amount = review.amount ? `¥${review.amount.toLocaleString('ja-JP')}` : '金額不明';
  const date = review.transactionDate || '日付不明';
  const debit = review.debitAccount || '?';
  const credit = review.creditAccount || '?';

  return {
    id: `correction-${review.id}`,
    type: 'correction',
    question: `${date}、${clientName}の取引 ${amount}。\n元の摘要:「${review.originalMemo || '（空）'}」\n\nAIが提案した摘要を答えてください。また適切な仕訳科目（借方/貸方）は？`,
    answer: `摘要:「${review.aiMemo || '（なし）'}」\n借方: ${debit} / 貸方: ${credit}`,
    hint: `このケースはAIが提案し、上長が承認した実例です。`,
    difficulty: 'medium',
    clientName,
    source: review.id,
  };
}

// Build training cards with OpenAI (richer scenarios)
async function enrichCardsWithAI(
  cards: TrainingCard[],
  openai: OpenAI,
): Promise<TrainingCard[]> {
  if (cards.length === 0) return cards;

  const subset = cards.slice(0, 10); // Limit tokens
  const prompt = `あなたは税理士事務所の研修担当者です。以下の研修カードを、新人スタッフが理解しやすいように改善してください。
各カードについて:
1. questionをより具体的な実務シナリオに書き換える（「〇月〇日、〇〇社から...」のような形式）
2. answerに「なぜその科目を使うか」の1行理由を追加する
3. hintに「よくある間違い」を1つ追加する

入力カード（JSON）:
${JSON.stringify(subset.map(c => ({ id: c.id, question: c.question, answer: c.answer, hint: c.hint })), null, 2)}

出力: 同じ配列構造のJSONのみを返してください。id, question, answer, hintフィールドだけ含める。`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.3,
    });
    const raw = res.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as { cards?: Array<{ id: string; question: string; answer: string; hint: string }> };
    const enriched = Array.isArray(parsed.cards) ? parsed.cards : [];
    const enrichMap = new Map(enriched.map((c) => [c.id, c]));

    return cards.map((card) => {
      const e = enrichMap.get(card.id);
      if (!e) return card;
      return { ...card, question: e.question || card.question, answer: e.answer || card.answer, hint: e.hint || card.hint };
    });
  } catch {
    return cards; // Fallback to non-enriched
  }
}

export async function getTrainingStats(firmId: string): Promise<TrainingStats> {
  const [ruleCount, correctionCount] = await Promise.all([
    prisma.rule.count({ where: { firmId, active: true } }),
    prisma.journalAiReview.count({ where: { firmId, status: { in: ['approved', 'auto_applied'] } } }),
  ]);
  return {
    ruleCount,
    correctionCount,
    cardCount: ruleCount + Math.min(correctionCount, 20),
    lastGeneratedAt: null,
  };
}

export async function generateTrainingCards(
  firmId: string,
  options: { useAI?: boolean; limit?: number } = {},
): Promise<TrainingCard[]> {
  const { useAI = false, limit = 30 } = options;

  // 1. Fetch active rules with client names
  const rules = await prisma.rule.findMany({
    where: { firmId, active: true },
    include: { client: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.ceil(limit * 0.6),
  });

  // 2. Fetch approved AI corrections
  const corrections = await prisma.journalAiReview.findMany({
    where: {
      firmId,
      status: { in: ['approved', 'auto_applied'] },
      aiMemo: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.floor(limit * 0.4),
  });

  // Get client names for corrections
  const correctionClientIds = [...new Set(corrections.map((c) => c.clientId))];
  const correctionClients = await prisma.client.findMany({
    where: { id: { in: correctionClientIds }, firmId },
    select: { id: true, name: true },
  });
  const clientNameById = new Map(correctionClients.map((c) => [c.id, c.name]));

  // 3. Build cards
  const ruleCards = rules.map((r) =>
    buildRuleCard(
      { id: r.id, title: r.title, detail: r.detail, industry: r.industry, severity: r.severity, clientId: r.clientId },
      r.client.name,
    ),
  );

  const correctionCards = corrections
    .map((r) =>
      buildCorrectionCard(
        {
          id: r.id,
          originalMemo: r.originalMemo,
          aiMemo: r.aiMemo,
          debitAccount: r.debitAccount,
          creditAccount: r.creditAccount,
          amount: r.amount,
          transactionDate: r.transactionDate,
          clientId: r.clientId,
        },
        clientNameById.get(r.clientId) ?? '顧問先',
      ),
    )
    .filter((c): c is TrainingCard => c !== null);

  let cards: TrainingCard[] = [...ruleCards, ...correctionCards];

  // 4. Optionally enrich with OpenAI
  if (useAI && process.env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    cards = await enrichCardsWithAI(cards, openai);
  }

  // Shuffle for variety
  return cards.sort(() => Math.random() - 0.5).slice(0, limit);
}
