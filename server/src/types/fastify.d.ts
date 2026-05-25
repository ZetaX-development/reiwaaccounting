import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      authUserId: string;
      firmId: string;
      role: 'owner' | 'member';
      email: string;
    };
  }
}
