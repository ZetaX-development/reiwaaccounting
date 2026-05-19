import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

const CANDIDATE_ACCOUNTS = [
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
].join('、');

const SYSTEM_PROMPT = `あなたは日本の中小企業の経費仕訳を提案するアシスタントです。
妥当な勘定科目・税区分・摘要を出してください。判断に必要な情報が不足している場合は、何が足りないかを missingFields に書いてください（例: '会食の参加者', '出張の目的'）。
候補となる勘定科目: ${CANDIDATE_ACCOUNTS}`;

const DraftJournalSchema = z.object({
  account: z.string(),
  taxClass: z.string().nullable(),
  description: z.string(),
  amount: z.number(),
  occurredAt: z.string(),
  missingFields: z.array(z.string()),
  reasoning: z.string(),
});

export type DraftJournal = z.infer<typeof DraftJournalSchema>;

const JSON_SCHEMA = {
  name: 'journal_draft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      account: { type: 'string' },
      taxClass: { type: ['string', 'null'] },
      description: { type: 'string' },
      amount: { type: 'number' },
      occurredAt: { type: 'string' },
      missingFields: { type: 'array', items: { type: 'string' } },
      reasoning: { type: 'string' },
    },
    required: [
      'account',
      'taxClass',
      'description',
      'amount',
      'occurredAt',
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
          content: `以下の領収書情報から仕訳ドラフトを提案してください。\n${JSON.stringify(userPayload, null, 2)}`,
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
    const nextStatus = parsed.missingFields.length > 0 ? 'needs_info' : 'drafted';
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
