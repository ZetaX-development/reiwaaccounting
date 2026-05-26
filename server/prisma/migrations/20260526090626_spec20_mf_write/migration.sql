-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "mfWriteAt" TIMESTAMP(3),
ADD COLUMN     "mfWriteError" TEXT,
ADD COLUMN     "mfWriteStatus" TEXT;

