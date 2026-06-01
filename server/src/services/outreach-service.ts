import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { getOutreachAdapter } from '../adapters/outreach-adapter.js';

interface DraftJournal {
  account?: string;
  taxClass?: string | null;
  description?: string;
  amount?: number;
  occurredAt?: string;
  missingFields?: string[];
  reasoning?: string;
}

interface OcrJson {
  issue_date: string | null;
  vendor_name: string | null;
  addressee: string | null;
  amount: number | null;
  invoice_number: string | null;
}

// spec 28: 当面ハードコードのデモ宛先。
// TODO: 顧問先ごとの連絡先メール（会社情報→連絡先タブ＝Client.contactEndpoints.email、
//       PATCH /api/clients/:id/contact で保存）を宛先に使うよう差し替える。
const DEMO_INQUIRY_EMAIL = 'kkouta2017@gmail.com';

function composeBody(args: {
  clientName: string;
  ocr: OcrJson | null;
  draft: DraftJournal | null;
  voucherId: string;
}): { subject: string; body: string } {
  const vendor = args.ocr?.vendor_name ?? '(発行者不明)';
  const issue = args.ocr?.issue_date ?? '(日付不明)';
  const amount =
    typeof args.ocr?.amount === 'number'
      ? `¥${args.ocr.amount.toLocaleString('ja-JP')}`
      : '(金額不明)';
  const missing = args.draft?.missingFields ?? [];
  const missingBlock =
    missing.length > 0
      ? missing.map((m) => `- ${m}`).join('\n')
      : '- (特になし)';

  const subject = `[bookmee] 経費の追加情報のお願い (${vendor})`;
  const body = `[bookmee] ${args.clientName} 様

お預かりした領収書について、以下の情報を教えていただけますでしょうか:

- 発行: ${vendor}
- 日付: ${issue}
- 金額: ${amount}

確認事項:
${missingBlock}

ご返信は本メール/LINE に直接ご返信ください。
(参照: voucher ${args.voucherId})
`;
  return { subject, body };
}

export async function inquireAboutVoucher(voucherId: string): Promise<void> {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      clientId: true,
      source: true,
      ocrJson: true,
      draftJournalJson: true,
      journalStatus: true,
    },
  });
  if (!voucher) return;

  // spec 28: LINE 由来の証憑は sendLinePushForVoucherStatus（spec 16）が送信者本人に
  // 質問を返すので、ここではメールを送らない（二重送信の防止）。web/drive のみ対象。
  if (voucher.source === 'line') return;

  let clientName = '(顧問先不明)';
  if (voucher.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: voucher.clientId },
      select: { name: true },
    });
    if (client) {
      clientName = client.name;
    }
  }

  // mock はローカル/テストの安全弁。それ以外は email で実送信（Resend）。
  const channel = env.OUTREACH_CHANNEL === 'mock' ? 'mock' : 'email';
  const target = DEMO_INQUIRY_EMAIL;
  const { subject, body } = composeBody({
    clientName,
    ocr: voucher.ocrJson as OcrJson | null,
    draft: voucher.draftJournalJson as DraftJournal | null,
    voucherId: voucher.id,
  });

  const adapter = getOutreachAdapter(channel);
  const result = await adapter.send(target, subject, body);

  await prisma.voucherInquiry.create({
    data: {
      firmId: 'demo-firm',
      voucherId: voucher.id,
      channel,
      target,
      body,
      status: result.ok ? 'sent' : 'failed',
      errorMessage: result.error ?? null,
    },
  });

  const now = new Date();
  const nextStatus =
    voucher.journalStatus === 'needs_info'
      ? 'inquired'
      : voucher.journalStatus;
  await prisma.voucher.update({
    where: { id: voucher.id },
    data: {
      inquiryAt: now,
      inquiryChannel: channel,
      journalStatus: nextStatus,
    },
  });
}
