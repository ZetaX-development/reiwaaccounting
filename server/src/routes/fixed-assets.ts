import type { FastifyInstance } from 'fastify';
import { getLiveMfEntries } from '../services/client-service.js';
import { prisma } from '../lib/prisma.js';
import { findUsefulLife } from '../data/useful-life.js';

/**
 * 固定資産として抽出する借方勘定科目の一覧。
 * MF の仕訳エントリの account フィールドと照合する。
 */
const FIXED_ASSET_ACCOUNTS = new Set([
  '工具器具備品',
  '車両運搬具',
  '建物附属設備',
  '一括償却資産',
  '少額減価償却資産',
]);

export interface FixedAssetItem {
  id: string;
  date: string;
  description: string;
  amount: number;
  account: string;
  usefulLifeYears: number | null;
  requiresContract: boolean;
  depreciationPerYear: number | null;
}

export async function fixedAssetRoutes(app: FastifyInstance) {
  /**
   * GET /api/clients/:id/fixed-assets
   *
   * クライアントの仕訳エントリから固定資産関連のものを抽出し、
   * 耐用年数・年間償却額概算を付与して返す。
   *
   * データソース:
   *   1. MF トークンがある場合 → getLiveMfEntries でライブ取得
   *   2. MF トークンがない場合 → Prisma の Entry テーブルから取得
   */
  app.get<{ Params: { id: string } }>('/api/clients/:id/fixed-assets', async (req, reply) => {
    const clientId = req.params.id;
    const firmId = req.user!.firmId;

    // マルチテナント: クライアントが firmId に属するか確認
    const client = await prisma.client.findFirst({
      where: { id: clientId, firmId },
      select: { id: true, mfAccessToken: true },
    });

    if (!client) {
      reply.code(404);
      return { error: { code: 'CLIENT_NOT_FOUND', message: 'client not found' } };
    }

    // エントリ取得（ライブ優先、なければ DB）
    let rawItems: Array<{ id: string; date: string; description: string; amount: number; account: string }> = [];

    if (client.mfAccessToken) {
      // ライブ MF エントリ
      const liveEntries = await getLiveMfEntries(clientId);
      rawItems = liveEntries.map((e, i) => ({
        id: `live-mf-${e.sourceEntryId || i}`,
        date: e.occurredAt.toISOString().slice(0, 10),
        description: e.description,
        amount: e.amount,
        account: e.account,
      }));
    } else {
      // DB エントリ（MF トークンなし）
      const dbEntries = await prisma.entry.findMany({
        where: { clientId, firmId },
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          occurredAt: true,
          description: true,
          amount: true,
          account: true,
        },
      });
      rawItems = dbEntries.map((e) => ({
        id: e.id,
        date: e.occurredAt.toISOString().slice(0, 10),
        description: e.description,
        amount: e.amount,
        account: e.account,
      }));
    }

    // 固定資産勘定科目で絞り込み
    const fixedAssetEntries = rawItems.filter((e) => FIXED_ASSET_ACCOUNTS.has(e.account));

    // 耐用年数・年間償却額を付与
    const items: FixedAssetItem[] = fixedAssetEntries.map((e) => {
      const usefulLife = findUsefulLife(e.description, e.amount);
      const usefulLifeYears = usefulLife?.years ?? null;
      const requiresContract = usefulLife?.requiresContract ?? false;
      // 年間償却額概算（定額法: 取得額 ÷ 耐用年数）
      const depreciationPerYear = usefulLifeYears != null && usefulLifeYears > 0
        ? Math.floor(e.amount / usefulLifeYears)
        : null;

      return {
        id: e.id,
        date: e.date,
        description: e.description,
        amount: e.amount,
        account: e.account,
        usefulLifeYears,
        requiresContract,
        depreciationPerYear,
      };
    });

    return { items };
  });
}

// ===== server.ts への登録方法 =====
// buildApp() 内で以下を追加してください:
//
//   import { fixedAssetRoutes } from './routes/fixed-assets.js';
//   ...
//   await app.register(fixedAssetRoutes);
