import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { getOutreachAdapter } from '../adapters/outreach-adapter.js';

// 不明出金照会メッセージを生成して送信する
// entries: 不明な出金のリスト [{ date, amount, description }]
export async function inquireAboutUnknownWithdrawals(
  clientId: string,
  entries: Array<{ date: string; amount: number; description: string }>,
): Promise<{ ok: boolean; message: string; body: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, contactEndpoints: true, firmId: true },
  });
  if (!client) return { ok: false, message: 'client not found', body: '' };

  const contactEndpoints = client.contactEndpoints as Record<string, string | null | undefined> | null;
  const channel = env.OUTREACH_CHANNEL;

  // ChatWork room ID は contactEndpoints.chatwork に格納
  let target = '';
  if (channel === 'chatwork') {
    target = contactEndpoints?.chatwork ?? '';
  } else if (channel === 'email') {
    target = contactEndpoints?.email ?? '';
  } else if (channel === 'line') {
    target = contactEndpoints?.line ?? contactEndpoints?.line_works ?? '';
  } else {
    target = contactEndpoints?.email ?? 'mock';
  }

  const entriesText = entries
    .map((e, i) => `  ${i + 1}. ${e.date}  ¥${e.amount.toLocaleString('ja-JP')}  ${e.description || '（摘要なし）'}`)
    .join('\n');

  const subject = `[bookmee] 銀行出金の内容確認のお願い - ${client.name}`;
  const body = `${client.name} 様

いつもお世話になっております。
経理処理に際し、以下の銀行口座からの出金について内容を確認させてください。

確認が必要な出金:
${entriesText}

各出金について、以下をご教示いただけますでしょうか:
- 何の支払いか（購入した物品・サービス名等）
- 領収書・請求書があればご送付ください

お忙しいところ恐れ入りますが、今月末までにご回答いただけますと助かります。
ご不明な点がございましたらお気軽にお申し付けください。

引き続きよろしくお願いいたします。`;

  const adapter = getOutreachAdapter(channel as 'mock' | 'email' | 'line' | 'chatwork');
  const result = await adapter.send(target, subject, body);

  // Threadに記録
  await prisma.thread.create({
    data: {
      firmId: client.firmId,
      clientId,
      channel,
      direction: 'outbound',
      subject,
      body,
      preview: `銀行出金 ${entries.length}件の内容確認`,
      status: result.ok ? 'sent' : 'error',
      errorMsg: result.error ?? null,
      sentAt: result.ok ? new Date() : null,
    },
  });

  return { ok: result.ok, message: result.ok ? '照会メッセージを送信しました' : (result.error ?? '送信失敗'), body };
}

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
  channel: 'mock' | 'email' | 'line' | 'chatwork',
): string {
  if (!contactEndpoints || typeof contactEndpoints !== 'object') return 'unknown';
  const map = contactEndpoints as Record<string, string | null | undefined>;
  if (channel === 'email') return map.email ?? 'unknown';
  if (channel === 'line') return map.line_works ?? map.line ?? 'unknown';
  if (channel === 'chatwork') return map.chatwork ?? 'unknown';
  return map.email ?? 'unknown';
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
      imageData: true,
      filename: true,
      mimeType: true,
    },
  });
  if (!voucher) return;

  // spec 28: LINE 由来の証憑は sendLinePushForVoucherStatus（spec 16）が送信者本人に
  // 質問を返すので、ここではメールを送らない（二重送信の防止）。web/drive のみ対象。
  if (voucher.source === 'line') return;

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
  const resolvedTarget = resolveTarget(contactEndpoints, channel);
  const target =
    channel === 'mock'
      ? DEMO_INQUIRY_EMAIL
      : channel === 'email' && resolvedTarget === 'unknown'
      ? DEMO_INQUIRY_EMAIL
      : resolvedTarget;
  const { subject, body } = composeBody({
    clientName,
    ocr: voucher.ocrJson as OcrJson | null,
    draft: voucher.draftJournalJson as DraftJournal | null,
    voucherId: voucher.id,
  });

  // spec 29: レシート写真を添付（顧客が何の証憑か分かるように）
  const attachments =
    voucher.imageData && voucher.imageData.length > 0
      ? [
          {
            filename: voucher.filename || `receipt-${voucher.id}.jpg`,
            content: Buffer.from(voucher.imageData).toString('base64'),
            contentType: voucher.mimeType || 'image/jpeg',
          },
        ]
      : undefined;

  const adapter = getOutreachAdapter(channel);
  const result = await adapter.send(target, subject, body, attachments);

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
