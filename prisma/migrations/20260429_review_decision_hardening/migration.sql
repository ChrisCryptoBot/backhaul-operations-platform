-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "RateConfirmation"
ADD COLUMN "reviewDecision" "ReviewDecision" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewReason" TEXT;
