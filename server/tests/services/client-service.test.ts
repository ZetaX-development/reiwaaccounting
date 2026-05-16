import { describe, it, expect, afterAll } from 'vitest';
import { listClients, getClientById } from '../../src/services/client-service.js';
import { prisma } from '../../src/lib/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('listClients', () => {
  it('returns the seeded clients with summary fields', async () => {
    const rows = await listClients();
    const aoyama = rows.find((r) => r.id === 'aoyama-design');
    expect(aoyama).toBeDefined();
    expect(aoyama!.vendor).toBe('mf');
    expect(aoyama!.progress).toBe(87);
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

describe('getClientById', () => {
  it('returns the client with nested collections', async () => {
    const client = await getClientById('aoyama-design');
    expect(client).toBeDefined();
    expect(client!.id).toBe('aoyama-design');
    expect(client!.entries.length).toBeGreaterThan(0);
    expect(client!.tasks.length).toBeGreaterThan(0);
  });

  it('returns null for unknown ids', async () => {
    const client = await getClientById('does-not-exist');
    expect(client).toBeNull();
  });
});
