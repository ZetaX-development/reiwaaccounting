import OpenAI from 'openai';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { findSimilarPatterns } from './journal-pattern-service.js';
import { findSimilarKnowledge } from './knowledge-service.js';

export interface ClientHistoryExample {
  debit: string;
  credit: string;
  amount: number;
  memo: string;
}

export interface RagInput {
  debit: string;
  credit: string;
  amount: number;
  date: string;
  originalMemo: string;
  /** 精度向上: 顧問先の業種 */
  clientIndustry?: string;
  /** 精度向上: 顧問先の承認済み仕訳履歴（最大5件がFew-shotとして使われる） */
  clientHistory?: ClientHistoryExample[];
}

export interface RagResult {
  memo: string;
  confidence: number;
  reasoning: string;
  canJudge: boolean;
  routing: 'auto_applied' | 'pending' | 'difficult';
  patternsUsed: string[];
  /** 参考にした会計事典チャンクの id（任意） */
  knowledgeUsed?: string[];
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 大口仕訳のしきい値（円） — これ以上は confidence を下げる */
const LARGE_AMOUNT_THRESHOLD = 1_000_000;
const LARGE_AMOUNT_CONFIDENCE_PENALTY = 0.12;

const AUTO_APPLY_THRESHOLD = 0.85;
const DIFFICULT_THRESHOLD = 0.60;

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

function routeByConfidence(confidence: number, canJudge: boolean): RagResult['routing'] {
  if (!canJudge || confidence < DIFFICULT_THRESHOLD) return 'difficult';
  if (confidence >= AUTO_APPLY_THRESHOLD) return 'auto_applied';
  return 'pending';
}

// ---------------------------------------------------------------------------
// 摘要品質チェック — 悪い摘要には confidence ペナルティを返す
// ---------------------------------------------------------------------------

function memoQualityPenalty(memo: string, debit: string, credit: string): number {
  if (!memo || memo.trim().length === 0) return 0.3;
  const t = memo.trim();

  if (t === debit || t === credit) return 0.25;
  if (t === `${debit}/${credit}` || t === `${debit}→${credit}`) return 0.25;
  if (['判断保留', '判断困難', '不明'].includes(t)) return 0.3;
  if (t.length < 3) return 0.2;
  if (t.length > 30) return 0.05;

  return 0;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(industry?: string): string {
  const industryLine = industry
    ? `この顧問先は「${industry}」の企業です。業種特有の仕訳パターンを優先的に参照してください。`
    : '';
  return [
    'あなたは日本の中小企業会計の専門家（税理士補助者）です。',
    'MFクラウド会計の仕訳の「摘要」欄を埋めるアシスタントとして動作します。',
    industryLine,
    '## 摘要作成のルール',
    '- 日本語で簡潔に1行（5〜28文字が理想）',
    '- 勘定科目名を摘要にそのまま繰り返さない（例: ×「旅費交通費」→ ○「大阪出張 新幹線代」）',
    '- 取引の実態が伝わる具体的な記述（得意先名・月次・工事名 等）',
    '- 類似パターンと顧問先履歴を参考にするが実態に合わせて調整する',
    '- 判断に必要な情報が不足している場合は canJudge: false を返す',
    '- 参考解説（会計事典）が提示された場合は、勘定科目の選択・消費税区分・個人/法人の違いの判断根拠として活用してよい',
    '',
    '## 固定資産 vs 消耗品費 — 金額閾値ルール（税法ベース）',
    '借方が工具器具備品・機械装置・車両運搬具等の固定資産科目、または消耗品費の場合は金額で以下を判断してください。',
    '① 10万円未満          → 消耗品費で全額損金（即時費用計上）',
    '② 10万円以上20万円未満 → 一括償却資産（3年間1/3ずつ均等償却）または③',
    '③ 10万円以上30万円未満 → 少額減価償却資産の特例（中小企業者等＝資本金1億以下・青色申告）適用なら全額損金、年間合計300万円限度',
    '④ 30万円以上           → 固定資産計上・法定耐用年数で減価償却（工具器具備品・機械装置・車両運搬具等）',
    '※中小企業特例が不明な場合は③の可能性に言及し canJudge: true で提案する',
    '',
    '## 期間配分（前払費用・未払費用）— よく指摘されるポイント',
    '以下のパターンは「当期発生・翌期支払」または「当期支払・翌期費用」の期間ずれが発生します。月末・期末で計上を忘れると指摘されます。',
    '【未払費用 → 負債計上】当期に発生済みで翌期に支払う費用',
    '  - 月末締め翌月払い家賃: (借)地代家賃 / (貸)未払費用',
    '  - 当月使用翌月請求の電気・ガス: (借)水道光熱費 / (貸)未払費用',
    '  - 当月利用翌月引落しの通信費: (借)通信費 / (貸)未払費用',
    '  - 月末締め翌月払い外注費: (借)外注費 / (貸)未払費用',
    '  - 当月発生借入利息の未払: (借)支払利息 / (貸)未払費用',
    '【前払費用 → 資産計上】当期に支払済みで翌期以降の費用分',
    '  - 年払い保険料の翌期分: (借)前払費用 / (貸)保険料',
    '  - 翌月家賃の先払い: (借)前払費用 / (貸)地代家賃',
    '  - 年払いSaaS・保守料の翌期分: (借)前払費用 / (貸)通信費',
    '※前払費用・未払費用の取り崩しは翌期に逆仕訳で行う',
    '',
    '## 出力形式',
    '{"memo":"...","confidence":0.0,"reasoning":"...","canJudge":true}',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// User Prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(
  input: RagInput,
  patternSection: string,
  historySection: string,
  knowledgeSection: string,
): string {
  const month = input.date ? new Date(input.date).getMonth() + 1 : null;
  const seasonalHint =
    month === 3 || month === 9
      ? '（決算月付近のため決算整理仕訳の可能性あり）'
      : month === 12
        ? '（年末調整・賞与・社会保険年度更新の可能性あり）'
        : month === 6
          ? '（夏季賞与支給月の可能性あり）'
          : '';

  const amountHint =
    input.amount >= LARGE_AMOUNT_THRESHOLD
      ? `⚠ 大口取引（¥${input.amount.toLocaleString('ja-JP')}）のため慎重に判定してください。`
      : '';

  return [
    historySection
      ? `【この顧問先の承認済み摘要履歴（最優先参照）】\n${historySection}\n`
      : '',
    `【参考パターン（類似仕訳の実例）】\n${patternSection || '該当なし'}\n`,
    knowledgeSection ? `【参考解説（会計事典）】\n${knowledgeSection}\n` : '',
    '【今回の仕訳】',
    `借方: ${input.debit}`,
    `貸方: ${input.credit}`,
    `金額: ¥${input.amount.toLocaleString('ja-JP')} ${amountHint}`,
    `日付: ${input.date}${seasonalHint}`,
    `元摘要: ${input.originalMemo || '(空欄)'}`,
    '',
    '上記を踏まえ、最も適切な摘要と確信度を JSON のみで返してください。',
  ]
    .join('\n');
}

// ---------------------------------------------------------------------------
// JSON パース
// ---------------------------------------------------------------------------

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseJsonResponse(raw: string | null | undefined): {
  memo: string;
  confidence: number;
  reasoning: string;
  canJudge: boolean;
} {
  if (!raw) {
    return { memo: '判断保留', confidence: 0, reasoning: 'AI応答が空でした。', canJudge: false };
  }
  try {
    const parsed = JSON.parse(raw) as {
      memo?: unknown;
      confidence?: unknown;
      reasoning?: unknown;
      canJudge?: unknown;
    };
    return {
      memo:
        typeof parsed.memo === 'string' && parsed.memo.trim().length > 0
          ? parsed.memo.trim()
          : '判断保留',
      confidence: clampConfidence(parsed.confidence),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '理由なし',
      canJudge: parsed.canJudge === true,
    };
  } catch {
    return { memo: '判断保留', confidence: 0, reasoning: 'JSON解析に失敗しました。', canJudge: false };
  }
}

// ---------------------------------------------------------------------------
// メイン: RAGパイプライン
// ---------------------------------------------------------------------------

export async function generateMemoWithRag(input: RagInput): Promise<RagResult> {
  // クエリテキスト（タグ検索 + embedding 検索に使われる）
  const queryText = [
    `借方: ${input.debit}`,
    `貸方: ${input.credit}`,
    `金額: ¥${input.amount.toLocaleString('ja-JP')}`,
    `日付: ${input.date}`,
    input.originalMemo ? `摘要: ${input.originalMemo}` : '',
    input.clientIndustry ? `業種: ${input.clientIndustry}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // パターン検索（セマンティック + タグ RRF + 勘定科目完全一致優先）
  const patterns = await findSimilarPatterns(input.debit, input.credit, queryText, 5);
  const patternsUsed = patterns.map((p) => p.id);

  // OpenAI 未設定フォールバック
  if (!env.OPENAI_API_KEY) {
    return {
      memo: patterns[0]?.memoExamples[0] ?? `${input.debit}/${input.credit}`,
      confidence: 0,
      reasoning: 'OPENAI_API_KEY 未設定のためAI判定を実施できませんでした。',
      canJudge: false,
      routing: 'difficult',
      patternsUsed,
      knowledgeUsed: [],
    };
  }

  // 会計事典ナレッジ検索（未投入・embedding 無しなら空配列でフォールバック）
  const knowledge = await findSimilarKnowledge(queryText, 3);
  const knowledgeUsed = knowledge.map((k) => k.id);
  const knowledgeSection = knowledge
    .map((k, i) => `${i + 1}. ${k.title}\n${k.content}`)
    .join('\n\n');

  // プロンプト構築
  const patternSection = patterns
    .map((p, i) => {
      const examples = p.memoExamples.slice(0, 4).map((e) => `"${e}"`).join(', ');
      return `${i + 1}. ${p.debit}/${p.credit}: ${p.scenario} → 摘要例: ${examples}`;
    })
    .join('\n');

  // 顧問先承認済み履歴: 同じ勘定科目ペアを優先
  const sortedHistory = (input.clientHistory ?? []).sort((a, b) => {
    const aMatch = a.debit === input.debit && a.credit === input.credit ? 1 : 0;
    const bMatch = b.debit === input.debit && b.credit === input.credit ? 1 : 0;
    return bMatch - aMatch;
  });
  const historySection = sortedHistory
    .slice(0, 5)
    .map(
      (h, i) =>
        `${i + 1}. ${h.debit}/${h.credit} ¥${h.amount.toLocaleString('ja-JP')} → 承認摘要: "${h.memo}"`,
    )
    .join('\n');

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: buildSystemPrompt(input.clientIndustry) },
        { role: 'user', content: buildUserPrompt(input, patternSection, historySection, knowledgeSection) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    const parsed = parseJsonResponse(completion.choices[0]?.message?.content);

    // 摘要品質ペナルティ
    const qualityPenalty = memoQualityPenalty(parsed.memo, input.debit, input.credit);
    const rawConfidence = parsed.confidence - qualityPenalty;

    // 大口取引 confidence キャップ
    const adjustedConfidence =
      input.amount >= LARGE_AMOUNT_THRESHOLD
        ? rawConfidence - LARGE_AMOUNT_CONFIDENCE_PENALTY
        : rawConfidence;

    const finalConfidence = Math.min(1, Math.max(0, adjustedConfidence));
    const routing = routeByConfidence(finalConfidence, parsed.canJudge);

    return {
      memo: parsed.memo,
      confidence: finalConfidence,
      reasoning: parsed.reasoning,
      canJudge: parsed.canJudge,
      routing,
      patternsUsed,
      knowledgeUsed,
    };
  } catch (err) {
    logger.warn({ err }, 'generateMemoWithRag failed');
    return {
      memo: patterns[0]?.memoExamples[0] ?? `${input.debit}/${input.credit}`,
      confidence: 0,
      reasoning: 'OpenAI呼び出しに失敗したため人手確認が必要です。',
      canJudge: false,
      routing: 'difficult',
      patternsUsed,
      knowledgeUsed,
    };
  }
}
