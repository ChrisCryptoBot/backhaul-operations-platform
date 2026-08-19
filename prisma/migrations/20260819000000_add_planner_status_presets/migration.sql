-- Daily-Planner F-column work-queue states. Additive enum values (PG 16 allows
-- ALTER TYPE ... ADD VALUE in a transaction; the values aren't used in this migration).
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'NEED_DRVR';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'NEED_ETA_TO_PU';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'NEED_ETA_TO_DEL';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'NEED_DEL_DRVR';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'NEED_RELAY_DRVR';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'TRANSFER';
ALTER TYPE "PuDelStatusPreset" ADD VALUE 'LOADED';
