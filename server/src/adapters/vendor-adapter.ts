export type VendorSource = 'freee' | 'mf';

export interface RawEntry {
  sourceEntryId: string;
  account: string;
  description: string;
  amount: number;
  taxClass?: string;
  occurredAt: Date;
  receiptStatus?: 'matched' | 'missing' | 'partial' | 'na';
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
