import { prisma } from '../lib/prisma.js';

export interface VendorStatusRow {
  vendor: 'freee' | 'mf';
  total: number;
  ok: number;
  warn: number;
  error: number;
  lastSync: string | null; // ISO string of most recent sync across clients
}

export interface SyncStatusResponse {
  vendors: VendorStatusRow[];
  // overall percentage of (clientId, vendor) pairs whose status='ok'
  okRate: number;
}

export async function getSyncStatus(): Promise<SyncStatusResponse> {
  const rows = await prisma.vendorSync.findMany({
    select: { vendor: true, status: true, lastSync: true },
  });

  const summary: Record<'freee' | 'mf', VendorStatusRow> = {
    freee: { vendor: 'freee', total: 0, ok: 0, warn: 0, error: 0, lastSync: null },
    mf: { vendor: 'mf', total: 0, ok: 0, warn: 0, error: 0, lastSync: null },
  };

  for (const r of rows) {
    const v = (r.vendor === 'freee' ? 'freee' : 'mf') as 'freee' | 'mf';
    summary[v].total += 1;
    if (r.status === 'ok') summary[v].ok += 1;
    else if (r.status === 'warn') summary[v].warn += 1;
    else if (r.status === 'error') summary[v].error += 1;
    const ls = r.lastSync?.toISOString() ?? null;
    if (ls && (!summary[v].lastSync || ls > summary[v].lastSync)) {
      summary[v].lastSync = ls;
    }
  }

  const totalAll = summary.freee.total + summary.mf.total;
  const okAll = summary.freee.ok + summary.mf.ok;
  const okRate = totalAll > 0 ? Math.round((okAll / totalAll) * 100) : 0;

  return { vendors: [summary.freee, summary.mf], okRate };
}
