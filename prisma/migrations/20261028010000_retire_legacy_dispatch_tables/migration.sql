-- Retires the old coordinator-task data model (regions, weeks, drop lots, per-load checklists, copilot/LLM and DAT settings).
-- DESTRUCTIVE: drops 24 tables and 28 types and every row in them. The TrueLane-shaped tables from
-- 20261028000000 (workspaces, vehicles, cost_profiles, loads, stops, trip_segments, load_decisions, drivers, assignments) are untouched.
-- Run it only against a database you are happy to lose the old data from; the demo database is throwaway.

-- DropForeignKey
ALTER TABLE "DistributionCenter" DROP CONSTRAINT "DistributionCenter_regionId_fkey";

-- DropForeignKey
ALTER TABLE "DropLot" DROP CONSTRAINT "DropLot_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Lane" DROP CONSTRAINT "Lane_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Broker" DROP CONSTRAINT "Broker_regionId_fkey";

-- DropForeignKey
ALTER TABLE "BrokerRep" DROP CONSTRAINT "BrokerRep_brokerId_fkey";

-- DropForeignKey
ALTER TABLE "RateConfirmation" DROP CONSTRAINT "RateConfirmation_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_dropLotId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_rateConfirmationId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_brokerId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_directCustomerId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_pickupDriverId_fkey";

-- DropForeignKey
ALTER TABLE "Load" DROP CONSTRAINT "Load_deliveryDriverId_fkey";

-- DropForeignKey
ALTER TABLE "LoadLeg" DROP CONSTRAINT "LoadLeg_loadId_fkey";

-- DropForeignKey
ALTER TABLE "LoadLeg" DROP CONSTRAINT "LoadLeg_driverId_fkey";

-- DropForeignKey
ALTER TABLE "LoadDisruptionEvent" DROP CONSTRAINT "LoadDisruptionEvent_loadId_fkey";

-- DropForeignKey
ALTER TABLE "LoadDisruptionEvent" DROP CONSTRAINT "LoadDisruptionEvent_regionId_fkey";

-- DropForeignKey
ALTER TABLE "WeekSnapshot" DROP CONSTRAINT "WeekSnapshot_regionId_fkey";

-- DropForeignKey
ALTER TABLE "FuelSurchargeIndex" DROP CONSTRAINT "FuelSurchargeIndex_regionId_fkey";

-- DropForeignKey
ALTER TABLE "FuelSurchargeIndex" DROP CONSTRAINT "FuelSurchargeIndex_updatedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "OperationalRule" DROP CONSTRAINT "OperationalRule_regionId_fkey";

-- DropForeignKey
ALTER TABLE "UserRegionRole" DROP CONSTRAINT "UserRegionRole_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserRegionRole" DROP CONSTRAINT "UserRegionRole_regionId_fkey";

-- DropForeignKey
ALTER TABLE "RegionConfig" DROP CONSTRAINT "RegionConfig_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Driver" DROP CONSTRAINT "Driver_regionId_fkey";

-- DropForeignKey
ALTER TABLE "Driver" DROP CONSTRAINT "Driver_homeDropLotId_fkey";

-- DropForeignKey
ALTER TABLE "DirectCustomer" DROP CONSTRAINT "DirectCustomer_regionId_fkey";

-- DropForeignKey
ALTER TABLE "BookingPlanEntry" DROP CONSTRAINT "BookingPlanEntry_regionId_fkey";

-- DropForeignKey
ALTER TABLE "BookingPlanEntry" DROP CONSTRAINT "BookingPlanEntry_driverId_fkey";

-- DropForeignKey
ALTER TABLE "BookingPlanEntry" DROP CONSTRAINT "BookingPlanEntry_brokerId_fkey";

-- DropForeignKey
ALTER TABLE "BookingPlanEntry" DROP CONSTRAINT "BookingPlanEntry_sourcedLoadId_fkey";

-- DropTable
DROP TABLE "Region";

-- DropTable
DROP TABLE "DistributionCenter";

-- DropTable
DROP TABLE "DropLot";

-- DropTable
DROP TABLE "Lane";

-- DropTable
DROP TABLE "Broker";

-- DropTable
DROP TABLE "BrokerRep";

-- DropTable
DROP TABLE "RateConfirmation";

-- DropTable
DROP TABLE "Load";

-- DropTable
DROP TABLE "LoadLeg";

-- DropTable
DROP TABLE "LoadDisruptionEvent";

-- DropTable
DROP TABLE "WeekSnapshot";

-- DropTable
DROP TABLE "FuelSurchargeIndex";

-- DropTable
DROP TABLE "OperationalRule";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "UserRegionRole";

-- DropTable
DROP TABLE "AuditLog";

-- DropTable
DROP TABLE "LlmProviderConfig";

-- DropTable
DROP TABLE "DatProviderConfig";

-- DropTable
DROP TABLE "MarketRateQuote";

-- DropTable
DROP TABLE "MarketVarianceEntry";

-- DropTable
DROP TABLE "RegionConfig";

-- DropTable
DROP TABLE "Driver";

-- DropTable
DROP TABLE "DirectCustomer";

-- DropTable
DROP TABLE "BookingPlanEntry";

-- DropEnum
DROP TYPE "Role";

-- DropEnum
DROP TYPE "FuelSurchargeSource";

-- DropEnum
DROP TYPE "ParseState";

-- DropEnum
DROP TYPE "DuplicateSignal";

-- DropEnum
DROP TYPE "ReviewDecision";

-- DropEnum
DROP TYPE "BrokerOnboardingStatus";

-- DropEnum
DROP TYPE "LoadStatus";

-- DropEnum
DROP TYPE "TaskDoneStatus";

-- DropEnum
DROP TYPE "DeliveryExceptionState";

-- DropEnum
DROP TYPE "LineHaulPricingModel";

-- DropEnum
DROP TYPE "RuleSeverity";

-- DropEnum
DROP TYPE "AttentionSeverity";

-- DropEnum
DROP TYPE "PuDelStatusPreset";

-- DropEnum
DROP TYPE "DriverType";

-- DropEnum
DROP TYPE "EquipmentType";

-- DropEnum
DROP TYPE "EquipmentAccessory";

-- DropEnum
DROP TYPE "PodStatusWorkflow";

-- DropEnum
DROP TYPE "LoadLegType";

-- DropEnum
DROP TYPE "ApptType";

-- DropEnum
DROP TYPE "DisruptionKind";

-- DropEnum
DROP TYPE "DisruptionReason";

-- DropEnum
DROP TYPE "DatEquipment";

-- DropEnum
DROP TYPE "DatRateType";

-- DropEnum
DROP TYPE "MarketPerformanceBand";

-- DropEnum
DROP TYPE "DriverAttribute";

-- DropEnum
DROP TYPE "DayOfWeek";

-- DropEnum
DROP TYPE "CadencePeriod";

-- DropEnum
DROP TYPE "BookingPlanStatus";

