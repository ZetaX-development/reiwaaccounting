import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

// 借方 (経費系) として AI に選ばせる候補。
const DEBIT_ACCOUNTS = [
  '旅費交通費',
  '消耗品費',
  '雑費',
  '接待交際費',
  '会議費',
  '新聞図書費',
  '通信費',
  '地代家賃',
  '水道光熱費',
  '福利厚生費',
  '外注費',
  '広告宣伝費',
  '支払手数料',
  '修繕費',
  '租税公課',
  '荷造運賃',
  '車両費',
].join('、');

// 貸方 (支払元) として候補。領収書は普通「現金」が多いが、カード・振込もある。
const CREDIT_ACCOUNTS = [
  '現金',
  '普通預金',
  '当座預金',
  '未払金',
  '未払費用',
  '事業主借',
  '預り金',
].join('、');

// MF クラウド会計の標準的な税区分。
const TAX_CLASSES = [
  '課税仕入10%',
  '課税仕入8%（軽減）',
  '非課税仕入',
  '不課税仕入',
  '対象外',
].join('、');

const SYSTEM_PROMPT = `あなたは日本の中小企業の経費仕訳を提案するアシスタントです。
日本の複式簿記 + MF クラウド会計の仕訳形式に従い、借方 (debit) と貸方 (credit) の両方を提案してください。

- 借方は経費系の勘定科目。候補: ${DEBIT_ACCOUNTS}
- 貸方は支払元。レシート / 領収書なら基本は「現金」、明らかにカード払いと読み取れるなら「未払金」、振込なら「普通預金」。候補: ${CREDIT_ACCOUNTS}
- 借方金額と貸方金額は同額（税込）にしてください。
- 税区分はインボイス番号 (T で始まる 13 桁) があれば「課税仕入10%」または「課税仕入8%（軽減）」のどちらかを内容から判断。なければ「対象外」を選んでください。候補: ${TAX_CLASSES}
- 取引先は OCR から読み取った発行者 (vendor_name)。読めなければ null。
- 摘要は 50 文字以内で「(発行者) — (内容の要約)」の形式。内容不明なら「(発行者) — 詳細不明、要確認」。
- 判断に必要な情報が不足している場合は missingFields に書いてください（例: '会食の参加者', '出張の目的', '支払方法（現金/カード/振込）'）。`;

// 1 行（借方または貸方）のスキーマ。
const JournalLineSchema = z.object({
  account: z.string(),
  subAccount: z.string().nullable(),
  partner: z.string().nullable(),
  taxClass: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  amount: z.number(),
});

const DraftJournalSchema = z.object({
  transactionDate: z.string(),
  debit: JournalLineSchema,
  credit: JournalLineSchema,
  description: z.string(),
  missingFields: z.array(z.string()),
  reasoning: z.string(),
});

export type DraftJournal = z.infer<typeof DraftJournalSchema>;

const lineSchemaJson = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account: { type: 'string' },
    subAccount: { type: ['string', 'null'] },
    partner: { type: ['string', 'null'] },
    taxClass: { type: ['string', 'null'] },
    invoiceNumber: { type: ['string', 'null'] },
    amount: { type: 'number' },
  },
  required: [
    'account',
    'subAccount',
    'partner',
    'taxClass',
    'invoiceNumber',
    'amount',
  ],
};

const JSON_SCHEMA = {
  name: 'journal_draft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      transactionDate: { type: 'string' },
      debit: lineSchemaJson,
      credit: lineSchemaJson,
      description: { type: 'string' },
      missingFields: { type: 'array', items: { type: 'string' } },
      reasoning: { type: 'string' },
    },
    required: [
      'transactionDate',
      'debit',
      'credit',
      'description',
      'missingFields',
      'reasoning',
    ],
  },
};

interface OcrJson {
  issue_date: string | null;
  vendor_name: string | null;
  addressee: string | null;
  amount: number | null;
  invoice_number: string | null;
}

export async function generateDraftJournal(voucherId: string): Promise<void> {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { id: true, clientId: true, ocrJson: true },
  });
  if (!voucher) return;

  const ocr = voucher.ocrJson as OcrJson | null;
  if (!ocr || ocr.amount == null || !ocr.issue_date) {
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { journalStatus: 'none' },
    });
    return;
  }

  await prisma.voucher.update({
    where: { id: voucherId },
    data: { journalStatus: 'drafting' },
  });

  let industry = 'その他';
  if (voucher.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: voucher.clientId },
      select: { industry: true },
    });
    if (client) industry = client.industry;
  }

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const userPayload = {
      vendor_name: ocr.vendor_name,
      addressee: ocr.addressee,
      amount: ocr.amount,
      issue_date: ocr.issue_date,
      invoice_number: ocr.invoice_number,
      業種: industry,
    };
    const completion = await client.chat.completions.create({
      model: env.OPENAI_VISION_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `以下の領収書情報から MF クラウド会計形式 (借方/貸方) の仕訳ドラフトを 1 行で提案してください。\n${JSON.stringify(userPayload, null, 2)}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: JSON_SCHEMA,
      },
    });
    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty content');
    const parsed = DraftJournalSchema.parse(JSON.parse(text));
    const nextStatus =
      parsed.missingFields.length > 0 ? 'needs_info' : 'drafted';
    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        draftJournalJson: parsed as unknown as object,
        journalStatus: nextStatus,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[journal-draft] generation failed for ${voucherId}: ${msg}`);
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { journalStatus: 'none' },
    });
  }
}
