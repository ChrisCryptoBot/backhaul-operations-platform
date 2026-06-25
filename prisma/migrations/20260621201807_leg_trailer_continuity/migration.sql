-- AlterTable
ALTER TABLE "LoadLeg" ADD COLUMN     "trailer" TEXT,
ADD COLUMN     "trailerHookConfirmed" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE';
