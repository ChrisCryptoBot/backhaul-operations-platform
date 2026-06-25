-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "bolMatchTask" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "deliveryArrivalAdvised" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "deliveryEtaAdvised" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "pickupArrivalAdvised" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "pickupEtaAdvised" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE';
