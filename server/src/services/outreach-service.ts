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

function resolveTarget(
  contactEndpoints: unknown,
  channel: 'mock' | 'email' | 'line',
): string {
  if (!contactEndpoints || typeof contactEndpoints !== 'object') return 'unknown';
  const map = contactEndpoints as Record<string, string | null | undefined>;
  if (channel === 'email') return map.email ?? 'unknown';
  if (channel === 'line') return map.line_works ?? map.line ?? 'unknown';
  return map.email ?? 'unknown';
}

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
      ocrJson: true,
      draftJournalJson: true,
      journalStatus: true,
    },
  });
  if (!voucher) return;

  let clientName = '(顧問先不明)';
  let contactEndpoints: unknown = null;
  if (voucher.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: voucher.clientId },
      select: { name: true, contactEndpoints: true },
    });
    if (client) {
      clientName = client.name;
      contactEndpoints = client.contactEndpoints;
    }
  }

  const channel = env.OUTREACH_CHANNEL;
  const target = resolveTarget(contactEndpoints, channel);
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
