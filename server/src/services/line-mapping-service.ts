import { prisma } from '../lib/prisma.js';
import type { LineUserMapping } from '@prisma/client';

export type LineUserMappingDTO = {
  id: string;
  lineUserId: string;
  displayName: string;
  staffLabel: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(row: LineUserMapping): LineUserMappingDTO {
  return {
    id: row.id,
    lineUserId: row.lineUserId,
    displayName: row.displayName,
    staffLabel: row.staffLabel,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listMappings(): Promise<LineUserMappingDTO[]> {
  const rows = await prisma.lineUserMapping.findMany({
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toDTO);
}

export async function getMapping(
  id: string,
): Promise<LineUserMappingDTO | null> {
  const row = await prisma.lineUserMapping.findUnique({ where: { id } });
  return row ? toDTO(row) : null;
}

export async function getMappingByLineUserId(
  lineUserId: string,
): Promise<LineUserMappingDTO | null> {
  const row = await prisma.lineUserMapping.findUnique({
    where: { lineUserId },
  });
  return row ? toDTO(row) : null;
}

export async function updateMapping(
  id: string,
  patch: { staffLabel?: string | null; enabled?: boolean },
): Promise<LineUserMappingDTO | null> {
  const exists = await prisma.lineUserMapping.findUnique({ where: { id } });
  if (!exists) return null;
  const data: { staffLabel?: string | null; enabled?: boolean } = {};
  if (patch.staffLabel !== undefined) data.staffLabel = patch.staffLabel;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  const updated = await prisma.lineUserMapping.update({
    where: { id },
    data,
  });
  return toDTO(updated);
}

export async function deleteMapping(id: string): Promise<boolean> {
  const result = await prisma.lineUserMapping.deleteMany({ where: { id } });
  return result.count > 0;
}

/**
 * Insert if missing, otherwise refresh the displayName. Created mappings
 * default to enabled=false so the 所長 must approve before image messages
 * are accepted.
 */
export async function upsertByLineUserId(
  lineUserId: string,
  displayName: string,
): Promise<LineUserMappingDTO> {
  const row = await prisma.lineUserMapping.upsert({
    where: { lineUserId },
    create: {
      lineUserId,
      displayName,
      enabled: false,
    },
    update: {
      displayName,
    },
  });
  return toDTO(row);
}

export async function setEnabledByLineUserId(
  lineUserId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.lineUserMapping.updateMany({
    where: { lineUserId },
    data: { enabled },
  });
}
