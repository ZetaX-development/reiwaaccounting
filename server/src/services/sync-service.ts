import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { freeeMockAdapter } from '../adapters/freee-mock.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import type { VendorAdapter, VendorSource } from '../adapters/vendor-adapter.js';
import { env } from '../env.js';

const adapters: Record<VendorSource, VendorAdapter> = {
  mf: mfApiAdapter,
  freee: freeeMockAdapter,
};

export function isStale(lastSync: Date | null, thresholdSec: number): boolean {
  if (!lastSync) return true;
  const ageMs = Date.now() - lastSync.getTime();
  return ageMs > thresholdSec * 1000;
}

export interface SyncResult {
  clientId: string;
  vendor: VendorSource;
  status: 'ok' | 'error';
  count: number;
  errorMsg?: string;
}

export async function syncClient(clientId: string): Promise<SyncResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    return { clientId, vendor: 'mf', status: 'error', count: 0, errorMsg: 'client not found' };
  }
  const vendor: VendorSource = client.vendor === 'freee' ? 'freee' : 'mf';
  const adapter = adapters[vendor];
  const externalId = client.mfExternalId ?? `mock-${client.id}`;

  try {
    const [entries, receipts, matchings] = await Promise.all([
      adapter.fetchEntries(externalId),
      adapter.fetchReceipts(externalId),
      adapter.fetchMatchings(externalId),
    ]);
    const total = entries.items.length + receipts.items.length + matchings.items.length;
    await prisma.vendorSync.upsert({
      where: { clientId_vendor: { clientId: client.id, vendor } },
      update: { lastSync: new Date(), status: 'ok', count: total, errorMsg: null },
      create: { firmId: 'demo-firm', clientId: client.id, vendor, lastSync: new Date(), status: 'ok', count: total },
    });
    logger.info({ clientId, vendor, total }, 'sync ok');
    return { clientId, vendor, status: 'ok', count: total };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await prisma.vendorSync.upsert({
      where: { clientId_vendor: { clientId: client.id, vendor } },
      update: { status: 'error', errorMsg },
      create: { firmId: 'demo-firm', clientId: client.id, vendor, status: 'error', errorMsg, count: 0 },
    });
    logger.error({ clientId, vendor, errorMsg }, 'sync failed');
    return { clientId, vendor, status: 'error', count: 0, errorMsg };
  }
}

export function revalidateInBackground(clientId: string): void {
  void syncClient(clientId).catch((err) => {
    logger.error({ err, clientId }, 'background revalidate failed');
  });
}

export const STALE_SEC = env.STALE_THRESHOLD_SEC;
export const MAX_AGE_SEC = env.MAX_AGE_SEC;
