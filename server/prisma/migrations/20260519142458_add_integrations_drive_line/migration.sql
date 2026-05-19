-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "driveFileId" TEXT,
ADD COLUMN     "driveImportStatus" TEXT,
ADD COLUMN     "lineSourceMessageId" TEXT,
ADD COLUMN     "lineUserId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "creds" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriveFolderMapping" (
    "id" TEXT NOT NULL,
    "driveFolderId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "importedSubfolderId" TEXT,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveFolderMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriveWatchChannel" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "pageToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriveWatchChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineUserMapping" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "staffLabel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineUserMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_type_key" ON "Integration"("type");

-- CreateIndex
CREATE UNIQUE INDEX "DriveFolderMapping_driveFolderId_key" ON "DriveFolderMapping"("driveFolderId");

-- CreateIndex
CREATE INDEX "DriveFolderMapping_clientId_idx" ON "DriveFolderMapping"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "DriveWatchChannel_channelId_key" ON "DriveWatchChannel"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "LineUserMapping_lineUserId_key" ON "LineUserMapping"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_driveFileId_key" ON "Voucher"("driveFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_lineSourceMessageId_key" ON "Voucher"("lineSourceMessageId");

-- AddForeignKey
ALTER TABLE "DriveFolderMapping" ADD CONSTRAINT "DriveFolderMapping_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

