-- Daily Board spec vocabulary alignment:
-- - PU/DEL preset enums
-- - POD workflow enum
-- - Equipment type/accessory enums

-- PU/DEL status enum transition
ALTER TYPE "PuDelStatusPreset" RENAME TO "PuDelStatusPreset_old";
CREATE TYPE "PuDelStatusPreset" AS ENUM (
  'ETA_TO_PU_DEL',
  'LOADED_SET_TO_DEL',
  'LATE',
  'DONE',
  'OTHER'
);

ALTER TABLE "Load"
  ALTER COLUMN "puStatusPreset" DROP DEFAULT,
  ALTER COLUMN "delStatusPreset" DROP DEFAULT;

ALTER TABLE "Load"
  ALTER COLUMN "puStatusPreset" TYPE "PuDelStatusPreset"
  USING (
    CASE "puStatusPreset"::text
      WHEN 'NOT_SET' THEN 'OTHER'
      WHEN 'ON_TIME' THEN 'DONE'
      WHEN 'LATE' THEN 'LATE'
      WHEN 'FAILED' THEN 'OTHER'
      WHEN 'CANCELED' THEN 'OTHER'
      ELSE 'OTHER'
    END
  )::"PuDelStatusPreset",
  ALTER COLUMN "delStatusPreset" TYPE "PuDelStatusPreset"
  USING (
    CASE "delStatusPreset"::text
      WHEN 'NOT_SET' THEN 'OTHER'
      WHEN 'ON_TIME' THEN 'DONE'
      WHEN 'LATE' THEN 'LATE'
      WHEN 'FAILED' THEN 'OTHER'
      WHEN 'CANCELED' THEN 'OTHER'
      ELSE 'OTHER'
    END
  )::"PuDelStatusPreset";

ALTER TABLE "Load"
  ALTER COLUMN "puStatusPreset" SET DEFAULT 'OTHER',
  ALTER COLUMN "delStatusPreset" SET DEFAULT 'OTHER';

DROP TYPE "PuDelStatusPreset_old";

-- Equipment type enum transition
ALTER TYPE "EquipmentType" RENAME TO "EquipmentType_old";
CREATE TYPE "EquipmentType" AS ENUM (
  'BOX_TRUCK',
  'FLATBED_OR_STEPDECK',
  'VAN_48',
  'VAN_53',
  'OTHER'
);

ALTER TABLE "Load"
  ALTER COLUMN "equipmentType" TYPE "EquipmentType"
  USING (
    CASE "equipmentType"::text
      WHEN 'DRY_VAN' THEN 'VAN_53'
      WHEN 'REEFER' THEN 'VAN_48'
      WHEN 'FLATBED' THEN 'FLATBED_OR_STEPDECK'
      WHEN 'OTHER' THEN 'OTHER'
      ELSE NULL
    END
  )::"EquipmentType";

DROP TYPE "EquipmentType_old";

-- Equipment accessory enum transition
ALTER TYPE "EquipmentAccessory" RENAME TO "EquipmentAccessory_old";
CREATE TYPE "EquipmentAccessory" AS ENUM (
  'STRAPS',
  'TARPS',
  'CHAINS',
  'BARS',
  'NONE',
  'OTHER'
);

ALTER TABLE "Load"
  ALTER COLUMN "equipmentAccessory" TYPE "EquipmentAccessory"
  USING (
    CASE "equipmentAccessory"::text
      WHEN 'STRAPS' THEN 'STRAPS'
      WHEN 'CHAINS' THEN 'CHAINS'
      WHEN 'NONE' THEN 'NONE'
      WHEN 'LIFTGATE' THEN 'OTHER'
      WHEN 'OTHER' THEN 'OTHER'
      ELSE NULL
    END
  )::"EquipmentAccessory";

DROP TYPE "EquipmentAccessory_old";

-- POD workflow enum migration from free-text string
CREATE TYPE "PodStatusWorkflow" AS ENUM (
  'NOT_REQUESTED',
  'REQUESTED',
  'UPLOADED',
  'SENT_TO_BROKER',
  'NEEDS_ATTENTION'
);

ALTER TABLE "Load"
  ALTER COLUMN "podStatus" TYPE "PodStatusWorkflow"
  USING (
    CASE UPPER(COALESCE("podStatus", ''))
      WHEN '' THEN NULL
      WHEN 'NOT_REQUESTED' THEN 'NOT_REQUESTED'
      WHEN 'REQUESTED' THEN 'REQUESTED'
      WHEN 'UPLOADED' THEN 'UPLOADED'
      WHEN 'SENT_TO_BROKER' THEN 'SENT_TO_BROKER'
      WHEN 'NEEDS_ATTENTION' THEN 'NEEDS_ATTENTION'
      WHEN 'PENDING' THEN 'REQUESTED'
      ELSE 'NEEDS_ATTENTION'
    END
  )::"PodStatusWorkflow";
