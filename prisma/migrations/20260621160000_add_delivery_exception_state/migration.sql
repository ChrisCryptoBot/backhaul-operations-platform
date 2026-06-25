-- CreateEnum
CREATE TYPE "DeliveryExceptionState" AS ENUM ('NONE', 'WORK_IN_REQUESTED', 'RESCHEDULED');

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "deliveryExceptionState" "DeliveryExceptionState" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "rescheduleDriverConfirmed" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE';
