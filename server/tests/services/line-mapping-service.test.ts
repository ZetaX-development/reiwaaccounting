import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  upsertByLineUserId,
  getMappingByLineUserId,
  listMappings,
  setEnabledByLineUserId,
  updateMapping,
  deleteMapping,
} from '../../src/services/line-mapping-service.js';

beforeEach(async () => {
  await prisma.lineUserMapping.deleteMany();
});

afterAll(async () => {
  await prisma.lineUserMapping.deleteMany();
  await prisma.$disconnect();
});

describe('upsertByLineUserId', () => {
  it('creates a new row with enabled=false by default', async () => {
    const row = await upsertByLineUserId('U123', 'Alice');
    expect(row.lineUserId).toBe('U123');
    expect(row.displayName).toBe('Alice');
    expect(row.enabled).toBe(false);
  });

  it('does not overwrite enabled on second upsert', async () => {
    await upsertByLineUserId('U1', 'A');
    await setEnabledByLineUserId('U1', true);
    await upsertByLineUserId('U1', 'A-updated');
    const row = await getMappingByLineUserId('U1');
    expect(row?.enabled).toBe(true);
    expect(row?.displayName).toBe('A-updated');
  });
});

describe('setEnabledByLineUserId', () => {
  it('toggles enabled', async () => {
    await upsertByLineUserId('U1', 'A');
    await setEnabledByLineUserId('U1', true);
    expect((await getMappingByLineUserId('U1'))?.enabled).toBe(true);
    await setEnabledByLineUserId('U1', false);
    expect((await getMappingByLineUserId('U1'))?.enabled).toBe(false);
  });
});

describe('updateMapping', () => {
  it('updates staffLabel', async () => {
    const row = await upsertByLineUserId('U1', 'A');
    const updated = await updateMapping(row.id, { staffLabel: '所長' });
    expect(updated?.staffLabel).toBe('所長');
  });

  it('updates enabled', async () => {
    const row = await upsertByLineUserId('U1', 'A');
    const updated = await updateMapping(row.id, { enabled: true });
    expect(updated?.enabled).toBe(true);
  });

  it('returns null for non-existent id', async () => {
    const result = await updateMapping('nonexistent-id', { enabled: true });
    expect(result).toBeNull();
  });
});

describe('deleteMapping', () => {
  it('deletes by id and returns true', async () => {
    const row = await upsertByLineUserId('U1', 'A');
    expect(await deleteMapping(row.id)).toBe(true);
    expect(await getMappingByLineUserId('U1')).toBeNull();
  });

  it('returns false for non-existent id', async () => {
    expect(await deleteMapping('nonexistent-id')).toBe(false);
  });
});

describe('listMappings', () => {
  it('returns all rows ordered by createdAt asc', async () => {
    await upsertByLineUserId('U1', 'A');
    await upsertByLineUserId('U2', 'B');
    const rows = await listMappings();
    expect(rows).toHaveLength(2);
    expect(rows[0].lineUserId).toBe('U1');
    expect(rows[1].lineUserId).toBe('U2');
  });
});
