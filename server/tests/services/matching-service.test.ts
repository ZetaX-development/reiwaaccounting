import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { createVoucher } from '../../src/services/voucher-service.js';
import { findMatchForVoucher } from '../../src/services/matching-service.js';
import * as clientService from '../../src/services/client-service.js';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

async function makeVoucher(ocrJson: unknown, clientId: string | null = null) {
  const meta = await createVoucher({
    clientId,
    filename: 't.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff]),
    uploadedBy: null,
  });
  await prisma.voucher.update({
    where: { id: meta.id },
    data: { ocrJson: ocrJson as any, ocrStatus: 'done' },
  });
  return meta.id;
}

function entry(id: string, amount: number, date: string) {
  return {
    sourceEntryId: id,
    account: '雑費',
    description: 'x',
    amount,
    occurredAt: new Date(date),
  } as any;
}

describe('findMatchForVoucher', () => {
  it('returns no_client when clientId is null', async () => {
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' });
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'no_client',
      matchedEntryId: null,
    });
  });

  it('returns no_data when ocrJson is missing fields', async () => {
    const id = await makeVoucher(
      { amount: null, issue_date: null },
      'aoyama-design',
    );
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'no_data',
      matchedEntryId: null,
    });
  });

  it('returns unmatched when MF returns no entries', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([]);
    const id = await makeVoucher(
      { amount: 100, issue_date: '2026-05-15' },
      'aoyama-design',
    );
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'unmatched',
      matchedEntryId: null,
    });
  });

  it('returns matched on amount+date match', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-05-17'),
    ]);
    const id = await makeVoucher(
      { amount: 100, issue_date: '2026-05-15' },
      'aoyama-design',
    );
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'matched',
      matchedEntryId: 'E1',
    });
  });

  it('picks closest date when multiple candidates', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-05-01'),
      entry('E2', 100, '2026-05-16'),
      entry('E3', 100, '2026-05-25'),
    ]);
    const id = await makeVoucher(
      { amount: 100, issue_date: '2026-05-15' },
      'aoyama-design',
    );
    const result = await findMatchForVoucher(id);
    expect(result.status).toBe('matched');
    expect(result.matchedEntryId).toBe('E2');
  });

  it('returns unmatched when amount matches but date >30 days', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-07-01'),
    ]);
    const id = await makeVoucher(
      { amount: 100, issue_date: '2026-05-15' },
      'aoyama-design',
    );
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'unmatched',
      matchedEntryId: null,
    });
  });
});
