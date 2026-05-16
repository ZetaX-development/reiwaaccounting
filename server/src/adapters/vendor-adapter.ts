export type VendorSource = 'freee' | 'mf';

export interface RawEntry {
  sourceEntryId: string;
  account: string;
  description: string;
  amount: number;
  taxClass?: string;
  occurredAt: Date;
  receiptStatus?: 'matched' | 'missing' | 'partial' | 'na';
  // MF specific: false = 未実現 (繰延/取消等), true = 実現済。freee モックは true 固定。
  isRealized?: boolean;
  raw?: unknown;
}

export interface RawReceipt {
  sourceReceiptId: string;
  status: 'attached' | 'missing' | 'candidate';
  vendorRef?: string;
  amount?: number;
  occurredAt: Date;
  raw?: unknown;
}

export interface RawMatching {
  invoiceRef: string;
  invoiceAmount: number;
  paidAmount: number;
  diffNote?: string;
  status: 'matched' | 'open' | 'urgent' | 'done';
  occurredAt: Date;
  raw?: unknown;
}

export interface FetchResult<T> {
  items: T[];
  fetchedAt: Date;
}

export interface VendorAdapter {
  readonly source: VendorSource;
  fetchEntries(externalClientId: string, since?: Date): Promise<FetchResult<RawEntry>>;
  fetchReceipts(externalClientId: string, since?: Date): Promise<FetchResult<RawReceipt>>;
  fetchMatchings(externalClientId: string): Promise<FetchResult<RawMatching>>;
}
