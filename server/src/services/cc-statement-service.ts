import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { generateDraftJournal } from './journal-draft-service.js';

export interface CcStatementRow {
  date: string;
  merchant: string;
  amount: number;
  memo?: string;
}

/**
 * Parse a credit-card statement CSV into normalized rows.
 *
 * Supported headers include:
 * - 日付,利用店名,金額
 * - 利用日,利用店名・商品名,支払金額
 * - 日付,摘要,出金金額
 */
export function parseCcCsv(csvText: string): CcStatementRow[] {
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const records = parseCsv(text);
  if (records.length < 2) return [];

  const headers = records[0].map((header) => header.trim());
  const dateIdx = findColIdx(headers, ['日付', '利用日', '取引日', 'date']);
  const merchantIdx = findColIdx(headers, [
    '利用店名',
    '利用店名・商品名',
    '摘要',
    '商品名',
    'merchant',
    '店名',
    '内容',
  ]);
  const amountIdx = findColIdx(headers, [
    '金額',
    '利用額',
    '支払金額',
    '出金金額',
    '引落金額',
    'amount',
    '円',
  ]);
  const memoIdx = findColIdx(headers, ['備考', 'メモ', 'memo']);

  if (dateIdx === -1 || merchantIdx === -1 || amountIdx === -1) {
    throw new Error(`CSVヘッダーを認識できません。列: ${headers.join(', ')}`);
  }

  const rows: CcStatementRow[] = [];
  for (const columns of records.slice(1)) {
    const rawDate = columns[dateIdx]?.trim() ?? '';
    const merchant = columns[merchantIdx]?.trim() ?? '';
    const rawAmount = columns[amountIdx]?.trim() ?? '';
    const memo = memoIdx === -1 ? '' : (columns[memoIdx]?.trim() ?? '');

    const date = normalizeDate(rawDate);
    if (!date || !merchant) continue;

    const amount = parseJpAmount(rawAmount);
    if (amount <= 0) continue;

    rows.push({
      date,
      merchant,
      amount,
      ...(memo ? { memo } : {}),
    });
  }
  return rows;
}

function findColIdx(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const idx = normalizedHeaders.findIndex((header) =>
      header.includes(normalizedCandidate),
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuote && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (char === ',' && !inQuote) {
      record.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuote) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  record.push(field);
  if (record.some((value) => value.trim() !== '')) records.push(record);
  return records;
}

function normalizeDate(raw: string): string | null {
  const slashOrHyphen = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/,
  );
  if (slashOrHyphen) {
    return formatValidDate(
      slashOrHyphen[1],
      slashOrHyphen[2],
      slashOrHyphen[3],
    );
  }

  const japanese = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (japanese) {
    return formatValidDate(japanese[1], japanese[2], japanese[3]);
  }
  return null;
}

function formatValidDate(
  rawYear: string,
  rawMonth: string,
  rawDay: string,
): string | null {
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${rawYear}-${rawMonth.padStart(2, '0')}-${rawDay.padStart(2, '0')}`;
}

function parseJpAmount(raw: string): number {
  const cleaned = raw.replace(/[¥￥,円\s]/g, '');
  if (cleaned.startsWith('-')) return 0;
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : 0;
}

function escapeCsvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildVoucherContent(row: CcStatementRow): Buffer {
  const columns: Array<string | number> = [row.date, row.merchant, row.amount];
  if (row.memo) columns.push(row.memo);
  return Buffer.from(columns.map(escapeCsvCell).join(','), 'utf8');
}

function buildVoucherFilename(row: CcStatementRow): string {
  const merchant = row.merchant
    .slice(0, 20)
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  return `CC_${row.date}_${merchant || 'merchant'}.csv`;
}

export interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
  voucherIds: string[];
}

export async function importCcStatement(params: {
  clientId: string;
  firmId: string;
  csvText: string;
  uploadedBy: string | null;
}): Promise<ImportResult> {
  const { clientId, firmId, csvText, uploadedBy } = params;

  let rows: CcStatementRow[];
  try {
    rows = parseCcCsv(csvText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      total: 0,
      created: 0,
      skipped: 0,
      errors: [message],
      voucherIds: [],
    };
  }

  if (rows.length === 0) {
    return {
      total: 0,
      created: 0,
      skipped: 0,
      errors: ['データ行が見つかりませんでした'],
      voucherIds: [],
    };
  }

  const result: ImportResult = {
    total: rows.length,
    created: 0,
    skipped: 0,
    errors: [],
    voucherIds: [],
  };

  for (const row of rows) {
    try {
      const content = buildVoucherContent(row);
      const voucher = await prisma.voucher.create({
        data: {
          firmId,
          clientId,
          filename: buildVoucherFilename(row),
          mimeType: 'text/csv',
          size: content.byteLength,
          imageData: content,
          uploadedBy,
          source: 'cc_csv',
          caption: row.merchant,
          ocrStatus: 'skipped',
          ocrJson: {
            issue_date: row.date,
            vendor_name: row.merchant,
            addressee: null,
            amount: row.amount,
            invoice_number: null,
            payment_method: 'クレジットカード',
            memo: row.memo ?? null,
            source: 'cc_csv',
          },
          matchStatus: 'unmatched',
          journalStatus: 'none',
        },
      });
      result.voucherIds.push(voucher.id);
      result.created++;
    } catch {
      result.skipped++;
      result.errors.push(`行スキップ: ${row.date} ${row.merchant}`);
    }
  }

  if (env.OPENAI_API_KEY && result.voucherIds.length > 0) {
    setImmediate(() => {
      for (const voucherId of result.voucherIds) {
        void generateDraftJournal(voucherId).catch(() => {});
      }
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bank Statement CSV parser & unknown withdrawal detector
// ---------------------------------------------------------------------------

export interface BankStatementRow {
  date: string;
  description: string; // 摘要・相手先
  withdrawal: number;  // 出金（0 なら入金）
  deposit: number;     // 入金（0 なら出金）
  balance?: number;    // 残高（任意）
  memo?: string;
}

/**
 * Parse a bank statement CSV into normalized rows.
 *
 * Supported header patterns:
 * - 日付 / 取引日 / 年月日        → date
 * - 摘要 / 内容 / 相手先 / 取引内容 → description
 * - 出金金額 / 引落金額 / 出金 / お支払金額 → withdrawal
 * - 入金金額 / 振込金額 / 入金 / お受取金額 → deposit
 * - 残高 / 差引残高              → balance（任意）
 */
export function parseBankCsv(csvText: string): BankStatementRow[] {
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const records = parseCsv(text);
  if (records.length < 2) return [];

  const headers = records[0].map((h) => h.trim());

  const dateIdx = findColIdx(headers, ['日付', '取引日', '年月日', 'date']);
  const descIdx = findColIdx(headers, [
    '摘要',
    '内容',
    '相手先',
    '取引内容',
    'description',
  ]);
  const withdrawalIdx = findColIdx(headers, [
    '出金金額',
    '引落金額',
    'お支払金額',
    '出金',
    'withdrawal',
  ]);
  const depositIdx = findColIdx(headers, [
    '入金金額',
    '振込金額',
    'お受取金額',
    '入金',
    'deposit',
  ]);
  const balanceIdx = findColIdx(headers, ['残高', '差引残高', 'balance']);
  const memoIdx = findColIdx(headers, ['備考', 'メモ', 'memo']);

  if (dateIdx === -1 || descIdx === -1) {
    throw new Error(`CSVヘッダーを認識できません。列: ${headers.join(', ')}`);
  }
  if (withdrawalIdx === -1 && depositIdx === -1) {
    throw new Error(
      `出金・入金いずれかの列が見つかりません。列: ${headers.join(', ')}`,
    );
  }

  const rows: BankStatementRow[] = [];
  for (const columns of records.slice(1)) {
    const rawDate = columns[dateIdx]?.trim() ?? '';
    const description = columns[descIdx]?.trim() ?? '';
    const rawWithdrawal =
      withdrawalIdx === -1 ? '' : (columns[withdrawalIdx]?.trim() ?? '');
    const rawDeposit =
      depositIdx === -1 ? '' : (columns[depositIdx]?.trim() ?? '');
    const rawBalance =
      balanceIdx === -1 ? '' : (columns[balanceIdx]?.trim() ?? '');
    const memo = memoIdx === -1 ? '' : (columns[memoIdx]?.trim() ?? '');

    const date = normalizeDate(rawDate);
    if (!date) continue;

    const withdrawal = parseJpAmount(rawWithdrawal);
    const deposit = parseJpAmount(rawDeposit);

    // 出金も入金も 0 の行はスキップ（合計行などを除外）
    if (withdrawal === 0 && deposit === 0) continue;

    const row: BankStatementRow = {
      date,
      description,
      withdrawal,
      deposit,
    };

    if (rawBalance !== '') {
      const balance = parseJpAmountSigned(rawBalance);
      if (Number.isFinite(balance)) row.balance = balance;
    }
    if (memo) row.memo = memo;

    rows.push(row);
  }
  return rows;
}

export interface UnknownWithdrawal {
  date: string;
  description: string;
  amount: number;
  reason: string; // 不明判定の理由（日本語）
}

/**
 * Detect withdrawals that are likely unknown or suspicious.
 *
 * Conditions (any one triggers "unknown"):
 * 1. description が空、"＊＊＊"、または "不明" を含む
 * 2. description が数字のみ（口座番号っぽい）
 * 3. description に "ATM" または "CD" が含まれ金額が丸数字でない
 * 4. amount >= 100,000 かつ description が 5 文字以下（短すぎる摘要）
 */
export function detectUnknownWithdrawals(
  rows: BankStatementRow[],
): UnknownWithdrawal[] {
  const unknowns: UnknownWithdrawal[] = [];

  for (const row of rows) {
    if (row.withdrawal <= 0) continue;

    const desc = row.description;
    const amount = row.withdrawal;

    // 条件1: 空・＊＊＊・不明
    if (!desc || desc === '＊＊＊' || desc.includes('不明')) {
      unknowns.push({
        date: row.date,
        description: desc,
        amount,
        reason: '摘要が空白または不明',
      });
      continue;
    }

    // 条件2: 数字のみ（口座番号っぽい）
    if (/^\d+$/.test(desc)) {
      unknowns.push({
        date: row.date,
        description: desc,
        amount,
        reason: '相手先が数字のみ（口座番号の可能性）',
      });
      continue;
    }

    // 条件3: ATM / CD かつ金額が丸数字でない
    if (/ATM|CD/i.test(desc) && amount % 1000 !== 0) {
      unknowns.push({
        date: row.date,
        description: desc,
        amount,
        reason: 'ATM/CD出金・端数あり（手数料混在の可能性）',
      });
      continue;
    }

    // 条件4: 高額出金かつ摘要が短い
    if (amount >= 100000 && desc.length <= 5) {
      unknowns.push({
        date: row.date,
        description: desc,
        amount,
        reason: '高額出金・摘要不足（相手先を要確認）',
      });
      continue;
    }
  }

  return unknowns;
}

/** 残高など負値もありうる金額パース（符号付き） */
function parseJpAmountSigned(raw: string): number {
  const cleaned = raw.replace(/[¥￥,円\s]/g, '');
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? Math.trunc(amount) : NaN;
}
