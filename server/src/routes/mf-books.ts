import type { FastifyInstance } from 'fastify';
import {
  getAccountingPeriod,
  getAccounts,
  getJournalBook,
  getSubAccounts,
  getTrialBalance,
} from '../services/mf-books-service.js';

// 顧問先 > 「会計帳簿」系のリードスルー API。すべて MF からライブ取得。
export async function mfBooksRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/mf/accounting-period',
    async (req, reply) => {
      const period = await getAccountingPeriod(req.params.id);
      if (!period) {
        reply.code(404);
        return { error: { code: 'NOT_CONNECTED', message: 'MF 連携が必要です' } };
      }
      return period;
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { start_date?: string; end_date?: string; account_id?: string; sub_account_id?: string };
  }>('/api/clients/:id/mf/journal-book', async (req, reply) => {
    const result = await getJournalBook(req.params.id, {
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      accountId: req.query.account_id,
      subAccountId: req.query.sub_account_id,
    });
    if (result === null) {
      reply.code(404);
      return { error: { code: 'NOT_CONNECTED', message: 'MF 連携が必要です' } };
    }
    return result;
  });

  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/mf/accounts',
    async (req, reply) => {
      const list = await getAccounts(req.params.id);
      if (list === null) {
        reply.code(404);
        return { error: { code: 'NOT_CONNECTED', message: 'MF 連携が必要です' } };
      }
      return { accounts: list };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/mf/sub-accounts',
    async (req, reply) => {
      const list = await getSubAccounts(req.params.id);
      if (list === null) {
        reply.code(404);
        return { error: { code: 'NOT_CONNECTED', message: 'MF 連携が必要です' } };
      }
      return { sub_accounts: list };
    },
  );

  app.get<{ Params: { id: string; type: string } }>(
    '/api/clients/:id/mf/trial-balance/:type',
    async (req, reply) => {
      const type = req.params.type;
      if (type !== 'bs' && type !== 'pl') {
        reply.code(400);
        return { error: { code: 'INVALID_PARAM', message: 'type は bs か pl' } };
      }
      const data = await getTrialBalance(req.params.id, type);
      if (data === null) {
        reply.code(404);
        return { error: { code: 'NOT_CONNECTED', message: 'MF 連携が必要です' } };
      }
      return data;
    },
  );
}
