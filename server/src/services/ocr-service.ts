import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../env.js';

const ExtractedFieldsSchema = z.object({
  issue_date: z.string().nullable(),
  vendor_name: z.string().nullable(),
  addressee: z.string().nullable(),
  amount: z.number().nullable(),
  invoice_number: z.string().nullable(),
  payment_method: z.string().nullable(),
});

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

const SYSTEM_PROMPT = `あなたは日本の領収書・請求書から構造化データを抽出するアシスタントです。
画像から以下の 6 フィールドを抽出して JSON で返してください。
- issue_date: 発行日 (YYYY-MM-DD 形式、和暦は西暦に変換)
- vendor_name: 発行者の名称（領収書を切った側）
- addressee: 宛名（領収書の「上様」など曖昧な場合も含めそのまま）
- amount: 税込合計金額（整数の円、カンマ・¥記号は除く）
- invoice_number: インボイス登録番号（T で始まる 13 桁）
- payment_method: 支払方法。領収書に記載があれば原文に近い表記で返す。
  例: "現金" / "クレジットカード" / "クレジット売上" / "VISA" / "電子マネー(PayPay)" /
  "QR決済" / "振込" / "デビットカード" など。但し以下に正規化して構わない:
  クレジット・カード・〇〇カード・信販系の文言 → "クレジットカード"、
  Suica/PayPay/QUICPay 等の電子マネー → "電子マネー"、
  銀行振込 → "振込"、現金・お預かり等 → "現金"。記載が無ければ null。

読み取れない / 該当が無いフィールドは null にしてください。推測で埋めないこと。
（payment_method は「クレジット売上」「カード」など記載があれば必ず拾う。曖昧なら原文のまま返してよい）`;

const JSON_SCHEMA = {
  name: 'voucher_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      issue_date: { type: ['string', 'null'] },
      vendor_name: { type: ['string', 'null'] },
      addressee: { type: ['string', 'null'] },
      amount: { type: ['number', 'null'] },
      invoice_number: { type: ['string', 'null'] },
      payment_method: { type: ['string', 'null'] },
    },
    required: [
      'issue_date',
      'vendor_name',
      'addressee',
      'amount',
      'invoice_number',
      'payment_method',
    ],
  },
};

export async function extractVoucherFields(
  imageData: Buffer,
  mimeType: string,
): Promise<ExtractedFields> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const dataUrl = `data:${mimeType};base64,${imageData.toString('base64')}`;
  const completion = await client.chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'この画像から指定 6 項目を抽出してください。',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: JSON_SCHEMA,
    },
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty content');
  const parsed = JSON.parse(text);
  return ExtractedFieldsSchema.parse(parsed);
}
