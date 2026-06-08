import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { importCcStatement } from '../services/cc-statement-service.js';

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

export async function ccStatementRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/cc-statement-import',
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

      const uploadedBy =
        typeof req.headers['x-uploaded-by'] === 'string'
          ? req.headers['x-uploaded-by']
          : null;
      const result = await importCcStatement({
        clientId: client.id,
        firmId: req.user!.firmId,
        csvText,
        uploadedBy,
      });

      reply.code(201);
      return result;
    },
  );
}
