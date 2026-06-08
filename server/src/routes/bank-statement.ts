import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import {
  parseBankCsv,
  detectUnknownWithdrawals,
} from '../services/cc-statement-service.js';
import type { BankStatementRow, UnknownWithdrawal } from '../services/cc-statement-service.js';

function isFileTooLarge(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    String(err.code) === 'FST_REQ_FILE_TOO_LARGE'
  );
}

function decodeCsvBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('shift_jis', { fatal: true }).decode(buffer);
  }
}

interface BankImportSummary {
  totalRows: number;
  totalWithdrawal: number;
  totalDeposit: number;
  unknownCount: number;
  unknownAmount: number;
}

export async function bankStatementRoutes(app: FastifyInstance) {
  /**
   * POST /api/clients/:id/bank-statement-import
   *
   * CSVをアップロードして銀行明細をパースし、不明出金を検出して返す。
   * DB には保存しない（ライブ返却のみ）。
   */
  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/bank-statement-import',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'client not found' } };
      }

      let data;
      try {
        data = await req.file();
      } catch (err: unknown) {
        reply.code(400);
        return {
          error: isFileTooLarge(err)
            ? { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' }
            : { code: 'INVALID_BODY', message: 'file upload required' },
        };
      }
      if (!data) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: 'file is required' },
        };
      }

      const filename = data.filename?.toLowerCase() ?? '';
      const isCsvMime =
        data.mimetype.includes('csv') || data.mimetype.startsWith('text/');
      if (!isCsvMime && !filename.endsWith('.csv')) {
        reply.code(400);
        return {
          error: {
            code: 'INVALID_MIME',
            message: 'CSV ファイルをアップロードしてください',
          },
        };
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (err: unknown) {
        if (isFileTooLarge(err)) {
          reply.code(400);
          return {
            error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' },
          };
        }
        throw err;
      }

      let csvText: string;
      try {
        csvText = decodeCsvBuffer(buffer);
      } catch {
        reply.code(400);
        return {
          error: {
            code: 'INVALID_ENCODING',
            message: 'UTF-8 または Shift-JIS のCSVをアップロードしてください',
          },
        };
      }

      let rows: BankStatementRow[];
      try {
        rows = parseBankCsv(csvText);
      } catch (err: unknown) {
        reply.code(422);
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: { code: 'PARSE_ERROR', message },
        };
      }

      if (rows.length === 0) {
        reply.code(422);
        return {
          error: {
            code: 'EMPTY_CSV',
            message: 'データ行が見つかりませんでした',
          },
        };
      }

      const unknowns: UnknownWithdrawal[] = detectUnknownWithdrawals(rows);

      const totalWithdrawal = rows.reduce((sum, r) => sum + r.withdrawal, 0);
      const totalDeposit = rows.reduce((sum, r) => sum + r.deposit, 0);
      const unknownAmount = unknowns.reduce((sum, u) => sum + u.amount, 0);

      const summary: BankImportSummary = {
        totalRows: rows.length,
        totalWithdrawal,
        totalDeposit,
        unknownCount: unknowns.length,
        unknownAmount,
      };

      reply.code(200);
      return { rows, unknowns, summary };
    },
  );

  /**
   * GET /api/clients/:id/bank-statement-unknowns
   *
   * このエンドポイントはインメモリにデータを保持しないため、
   * 「最後にインポートしたデータ」を参照することができない。
   * CSVデータはDBに保存しない方針（CLAUDE.md: ライブ取得原則）なので、
   * 空レスポンスを返してクライアントに再インポートを促す。
   */
  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/bank-statement-unknowns',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'client not found' } };
      }

      reply.code(200);
      return {
        unknowns: [],
        message:
          '銀行明細がインポートされていません。POST /bank-statement-import でCSVをアップロードしてください。',
      };
    },
  );
}

/*
 * server.ts への登録方法:
 *
 * import { bankStatementRoutes } from './routes/bank-statement.js';
 *
 * // buildApp() 内の register 群に追加:
 * await app.register(bankStatementRoutes);
 */
