-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "crmStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "freeeAccessToken" TEXT,
ADD COLUMN     "freeeExternalId" TEXT,
ADD COLUMN     "freeeRefreshToken" TEXT,
ADD COLUMN     "freeeTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "lastContactAt" TIMESTAMP(3),
ADD COLUMN     "memo" TEXT,
ADD COLUMN     "tags" TEXT[];

