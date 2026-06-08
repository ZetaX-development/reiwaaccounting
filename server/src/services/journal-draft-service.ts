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
  // 固定資産・少額減価償却資産
  '工具器具備品',
  '車両運搬具',
  '建物附属設備',
  '一括償却資産',
  '少額減価償却資産',
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

// ===== 売上側（請求書）プロンプト =====
const INVOICE_SYSTEM_PROMPT = `あなたは日本の中小企業の売上仕訳を提案するアシスタントです。
入力は発行した請求書または入金証憑です。日本の複式簿記 + MF クラウド会計の仕訳形式に従い、借方 (debit) と貸方 (credit) の両方を提案してください。

## 売上仕訳のルール

**請求書発行時（売上計上）:**
- 借方: 売掛金（相手先名を partner に入れる）
- 貸方: 売上高（subAccount に業種・サービス名があれば入れる）

**入金確認時（回収）:**
- 借方: 普通預金 / 当座預金 / 現金（入金先口座）
- 貸方: 売掛金

**どちらか不明な場合:** 請求書なら「売掛金 / 売上高」を選び missingFields に「入金確認後は売掛金→普通預金の仕訳も必要」を追加する。

## その他のルール
- 借方候補: 売掛金、受取手形、普通預金、当座預金、現金、未収入金
- 貸方候補: 売上高、受取手数料、雑収入、売掛金、前受金
- 税区分（売上側）候補: 課税売上10%、課税売上8%（軽減）、非課税売上、輸出免税、対象外
- インボイス番号があれば登録番号として記録する
- 摘要は「(取引先名) — (サービス/商品名) (請求月等)」の形式、50文字以内
- 取引先は vendor_name または addressee から判断（発行先を記録）
- 判断に必要な情報が不足している場合は missingFields に追記してください`;

const SYSTEM_PROMPT = `あなたは日本の中小企業の経費仕訳を提案するアシスタントです。
入力に「追加情報」フィールドがある場合は、スタッフが補足した情報です。最優先で仕訳に反映してください。
日本の複式簿記 + MF クラウド会計の仕訳形式に従い、借方 (debit) と貸方 (credit) の両方を提案してください。

## 固定資産・少額資産の判定（金額に応じて必ず適用）
入力の amount（税込）を確認し、以下のルールで借方勘定科目を決定してください:

1. **10万円未満** → 消耗品費（少額資産、全額費用処理）
2. **10万円以上 20万円未満** → 一括償却資産（3年均等償却）
3. **20万円以上 30万円未満** → 原則: 工具器具備品などの固定資産。
   ただし資本金3000万円以下の中小企業（中小企業等の特例）では「少額減価償却資産」として全額費用処理可能。
   顧問先の規模が不明な場合は固定資産（工具器具備品等）を選び、missingFieldsに「中小企業特例の適用可否（資本金3000万円以下か）」を追加。
4. **30万円以上** → 工具器具備品・車両運搬具・建物附属設備 等の固定資産科目を内容で判断。
   資産の種類が不明なら missingFields に「固定資産の種類（PC/車/設備等）」を追加。

上記ルールはPCや機器類・車両・設備など明らかに固定資産と判断できる品目の場合のみ適用。
日常消耗品（文房具等）や食費・交通費等は金額に関係なく通常の経費科目を使う。

## 耐用年数の目安（missingFields に含める）
固定資産と判断した場合、以下の耐用年数を missingFields または reasoning に含めてください:
- PC・サーバ: 4年 / パソコン用ソフトウェア: 5年
- 普通自動車: 6年 / 軽自動車: 4年
- コピー機・複合機: 5年 / 電話・FAX: 10年
- エアコン（建物附属設備）: 13年
- 一般の工具器具備品: 5年
品目が不明な場合は「耐用年数を確認してください（資産種類によって異なります）」と missingFields に追加。

## 契約書・見積書チェック
**30万円以上の固定資産**の場合、必ず missingFields に「契約書または見積書の添付・確認」を追加してください。

## 通常科目
- 借方は経費系の勘定科目。候補: ${DEBIT_ACCOUNTS}
- 貸方は支払元。**入力の payment_method を最優先で使う**:
  - "現金" → 「現金」
  - "クレジットカード" / "クレジット" / "カード" / "VISA" 等の信販系 → 「未払金」
  - "電子マネー" / "QR決済" / "PayPay" 等 → 「未払金」（または「事業主借」が妥当なら そちら）
  - "振込" / "銀行振込" → 「普通預金」
  - payment_method が null（領収書に支払方法の記載が無い）場合のみ、レシートの体裁から推定し、
    確信が持てなければ missingFields に「支払方法（現金/カード/振込）」を入れる。
  候補: ${CREDIT_ACCOUNTS}
- 借方金額と貸方金額は同額（税込）にしてください。
- 税区分はインボイス番号 (T で始まる 13 桁) があれば「課税仕入10%」または「課税仕入8%（軽減）」のどちらかを内容から判断。なければ「対象外」を選んでください。候補: ${TAX_CLASSES}
- 取引先は OCR から読み取った発行者 (vendor_name)。読めなければ null。
- 摘要は 50 文字以内で「(発行者) — (内容の要約)」の形式。内容不明なら「(発行者) — 詳細不明、要確認」。
- 判断に必要な情報が不足している場合は missingFields に書いてください（例: '会食の参加者', '出張の目的'）。
  **payment_method が入力に与えられている場合は「支払方法」を missingFields に入れないこと。**`;

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
  payment_method?: string | null;
}

export async function generateDraftJournal(voucherId: string): Promise<void> {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      clientId: true,
      ocrJson: true,
      lineAnswers: true,
      source: true,
      matchStatus: true,
    },
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
    const lineAnswers = (voucher.lineAnswers ?? {}) as Record<string, string>;
    const hasAnswers = Object.keys(lineAnswers).length > 0;
    const isInvoice = voucher.source === 'invoice';
    const userPayload: Record<string, unknown> = {
      vendor_name: ocr.vendor_name,
      addressee: ocr.addressee,
      amount: ocr.amount,
      issue_date: ocr.issue_date,
      invoice_number: ocr.invoice_number,
      payment_method: ocr.payment_method ?? null,
      業種: industry,
      ...(isInvoice ? { 証憑種別: '請求書（売上）' } : {}),
      ...(hasAnswers ? { 追加情報: lineAnswers } : {}),
    };
    const systemPrompt = isInvoice ? INVOICE_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const userMessage = isInvoice
      ? `以下の請求書情報から MF クラウド会計形式 (借方/貸方) の売上仕訳ドラフトを 1 行で提案してください。\n${JSON.stringify(userPayload, null, 2)}`
      : `以下の領収書情報から MF クラウド会計形式 (借方/貸方) の仕訳ドラフトを 1 行で提案してください。\n${JSON.stringify(userPayload, null, 2)}`;
    const completion = await client.chat.completions.create({
      model: env.OPENAI_VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: userMessage,
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
    const hasMissing = parsed.missingFields.length > 0;
    // spec 30: 不足情報が全て解消され、かつ MF 未一致なら、人手承認なしで自動確定する。
    const autoClassify = !hasMissing && voucher.matchStatus !== 'matched';
    const nextStatus = hasMissing
      ? 'needs_info'
      : autoClassify
        ? 'approved'
        : 'drafted';
    const draftToSave = autoClassify
      ? { ...parsed, autoClassified: true }
      : parsed;
    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        draftJournalJson: draftToSave as unknown as object,
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
