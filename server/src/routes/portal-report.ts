import type { FastifyInstance } from 'fastify';
import { getPortalReport, getOrCreatePortalToken, disablePortalToken } from '../services/portal-service.js';

export async function portalReportRoutes(app: FastifyInstance) {
  // 公開: トークンで認証不要
  app.get<{ Params: { token: string } }>('/api/portal/:token', async (req, reply) => {
    const report = await getPortalReport(req.params.token);
    if (!report) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'portal not found or disabled' } };
    }
    return report;
  });

  // 保護: トークン発行
  app.post<{ Params: { id: string } }>('/api/clients/:id/portal-token', async (req, reply) => {
    const token = await getOrCreatePortalToken(req.params.id, req.user!.firmId);
    const portalUrl = `${req.protocol}://${req.hostname}/portal.html?token=${token}`;
    reply.code(201);
    return { token, portalUrl };
  });

  // 保護: トークン無効化
  app.delete<{ Params: { id: string } }>('/api/clients/:id/portal-token', async (req, reply) => {
    const ok = await disablePortalToken(req.params.id, req.user!.firmId);
    if (!ok) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'portal not found' } };
    }
    return { ok: true };
  });
}
