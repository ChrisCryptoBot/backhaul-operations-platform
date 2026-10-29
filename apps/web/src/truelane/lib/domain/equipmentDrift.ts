// VENDORED from TrueLane lib/domain/equipmentDrift.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Equipment Drift Detection (Phase 11 Hardening).
 * Compares load requirements against vehicle capabilities to prevent operational failures.
 */

export type DriftLevel = 'BLOCK' | 'WARNING' | 'MATCH';

export interface DriftIssue {
  field: string;
  label: string;
  loadValue: string | number | boolean;
  vehicleValue: string | number | boolean;
  level: DriftLevel;
  message: string;
}

export interface EquipmentDriftResult {
  eligible: boolean;
  issues: DriftIssue[];
  hasBlockers: boolean;
}

export interface DriftSpecs {
  weightLbs?: number | null;
  lengthFt?: number | null;
  widthFt?: number | null;
  heightIn?: number | null;
  requiresLiftgate?: boolean;
  requiresRamp?: boolean;
  requiresPalletJack?: boolean;
}

export interface VehicleSpecs {
  payloadLbs?: number | null;
  maxLengthFt?: number | null;
  maxWidthFt?: number | null;
  maxHeightIn?: number | null;
  hasLiftgate?: boolean;
  hasRamp?: boolean;
  hasPalletJack?: boolean;
}

export function detectEquipmentDrift(load: DriftSpecs, vehicle: VehicleSpecs): EquipmentDriftResult {
  const issues: DriftIssue[] = [];

  // 1. Weight Check (BLOCK)
  if (load.weightLbs && vehicle.payloadLbs && load.weightLbs > vehicle.payloadLbs) {
    issues.push({
      field: 'weightLbs',
      label: 'Weight',
      loadValue: load.weightLbs,
      vehicleValue: vehicle.payloadLbs,
      level: 'BLOCK',
      message: `Load weight (${load.weightLbs} lbs) exceeds vehicle payload capacity (${vehicle.payloadLbs} lbs).`,
    });
  }

  // 2. Dimensions Check (BLOCK)
  if (load.lengthFt && vehicle.maxLengthFt && load.lengthFt > vehicle.maxLengthFt) {
    issues.push({
      field: 'lengthFt',
      label: 'Length',
      loadValue: load.lengthFt,
      vehicleValue: vehicle.maxLengthFt,
      level: 'BLOCK',
      message: `Load length (${load.lengthFt} ft) exceeds vehicle max length (${vehicle.maxLengthFt} ft).`,
    });
  }

  if (load.widthFt && vehicle.maxWidthFt && load.widthFt > vehicle.maxWidthFt) {
    issues.push({
      field: 'widthFt',
      label: 'Width',
      loadValue: load.widthFt,
      vehicleValue: vehicle.maxWidthFt,
      level: 'BLOCK',
      message: `Load width (${load.widthFt} ft) exceeds vehicle max width (${vehicle.maxWidthFt} ft).`,
    });
  }

  if (load.heightIn && vehicle.maxHeightIn && load.heightIn > vehicle.maxHeightIn) {
    issues.push({
      field: 'heightIn',
      label: 'Height',
      loadValue: load.heightIn,
      vehicleValue: vehicle.maxHeightIn,
      level: 'BLOCK',
      message: `Load height (${load.heightIn} in) exceeds vehicle max height (${vehicle.maxHeightIn} in).`,
    });
  }

  // 3. Accessorials Check (WARNING)
  if (load.requiresLiftgate && !vehicle.hasLiftgate) {
    issues.push({
      field: 'requiresLiftgate',
      label: 'Liftgate',
      loadValue: true,
      vehicleValue: false,
      level: 'WARNING',
      message: 'Load requires a liftgate, but this vehicle is not equipped with one.',
    });
  }

  if (load.requiresRamp && !vehicle.hasRamp) {
    issues.push({
      field: 'requiresRamp',
      label: 'Ramp',
      loadValue: true,
      vehicleValue: false,
      level: 'WARNING',
      message: 'Load requires a ramp, but this vehicle is not equipped with one.',
    });
  }

  if (load.requiresPalletJack && !vehicle.hasPalletJack) {
    issues.push({
      field: 'requiresPalletJack',
      label: 'Pallet Jack',
      loadValue: true,
      vehicleValue: false,
      level: 'WARNING',
      message: 'Load requires a pallet jack, but this vehicle is not equipped with one.',
    });
  }

  const hasBlockers = issues.some(i => i.level === 'BLOCK');

  return {
    eligible: !hasBlockers,
    issues,
    hasBlockers,
  };
}

/** One-line summary of a drift result for the accountability trail. */
export function summarizeDrift(result: EquipmentDriftResult): string {
  return result.issues.map((i) => i.message).join('; ');
}
