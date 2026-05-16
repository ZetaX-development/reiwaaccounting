import type {
  FetchResult,
  RawEntry,
  RawMatching,
  RawReceipt,
  VendorAdapter,
} from './vendor-adapter.js';

const fixtures: Record<
  string,
  { entries: RawEntry[]; receipts: RawReceipt[]; matchings: RawMatching[] }
> = {
  'mock-aoyama-design': {
    entries: [
      {
        sourceEntryId: 'freee-aoyama-1',
        account: '広告宣伝費',
        description: 'Meta広告 220,000円',
        amount: 220000,
        taxClass: '課税仕入10%',
        occurredAt: new Date('2026-04-12'),
        receiptStatus: 'missing',
      },
      {
        sourceEntryId: 'freee-aoyama-2',
        account: '消耗品費',
        description: 'PC周辺機器 42,800円',
        amount: 42800,
        taxClass: '課税仕入10%',
        occurredAt: new Date('2026-04-15'),
        receiptStatus: 'matched',
      },
    ],
    receipts: [
      {
        sourceReceiptId: 'freee-rec-aoyama-1',
        status: 'attached',
        vendorRef: 'Adobe',
        amount: 8000,
        occurredAt: new Date('2026-04-10'),
      },
    ],
    matchings: [
      {
        invoiceRef: 'INV-0421',
        invoiceAmount: 330000,
        paidAmount: 326700,
        diffNote: '振込手数料候補',
        status: 'open',
        occurredAt: new Date('2026-04-30'),
      },
    ],
  },
};

function pick<T>(externalId: string, key: 'entries' | 'receipts' | 'matchings'): T[] {
  const f = fixtures[externalId];
  if (!f) return [];
  return f[key] as unknown as T[];
}

export const freeeMockAdapter: VendorAdapter = {
  source: 'freee',
  async fetchEntries(externalId): Promise<FetchResult<RawEntry>> {
    return { items: pick<RawEntry>(externalId, 'entries'), fetchedAt: new Date() };
  },
  async fetchReceipts(externalId): Promise<FetchResult<RawReceipt>> {
    return { items: pick<RawReceipt>(externalId, 'receipts'), fetchedAt: new Date() };
  },
  async fetchMatchings(externalId): Promise<FetchResult<RawMatching>> {
    return { items: pick<RawMatching>(externalId, 'matchings'), fetchedAt: new Date() };
  },
};
