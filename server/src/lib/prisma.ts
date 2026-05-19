import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __bookmeePrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__bookmeePrisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__bookmeePrisma = prisma;
}
