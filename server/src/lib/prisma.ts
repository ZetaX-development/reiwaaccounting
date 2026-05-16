import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __zeimeePrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__zeimeePrisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__zeimeePrisma = prisma;
}
