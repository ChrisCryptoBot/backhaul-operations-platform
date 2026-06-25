import type { Role } from "@/lib/rbac";
import { PolicyViolationError } from "@/lib/policy-error";

export type PolicyResource =
  | "BOARD"
  | "KPI_DASHBOARD"
  | "RATE_CONFIRMATION_UPLOAD"
  | "RATE_CONFIRMATION_REVIEW"
  | "FSC_INDEX"
  | "REFERENCE_DATA"
  | "SYSTEM_SETTINGS";

export type PolicyAction = "READ" | "WRITE" | "REVIEW";

export interface PolicyPermission {
  resource: PolicyResource;
  action: PolicyAction;
}

const permissionMatrix: Record<Role, Partial<Record<PolicyResource, PolicyAction[]>>> = {
  COORDINATOR: {
    BOARD: ["READ", "WRITE"],
    KPI_DASHBOARD: ["READ", "WRITE"],
    RATE_CONFIRMATION_UPLOAD: ["WRITE"],
    RATE_CONFIRMATION_REVIEW: ["READ", "REVIEW"],
    FSC_INDEX: ["WRITE"],
    // Coordinators may view reference data but not manage it.
    REFERENCE_DATA: ["READ"]
  },
  REGIONAL_MANAGER: {
    BOARD: ["READ", "WRITE"],
    KPI_DASHBOARD: ["READ", "WRITE"],
    RATE_CONFIRMATION_UPLOAD: ["WRITE"],
    RATE_CONFIRMATION_REVIEW: ["READ", "REVIEW"],
    FSC_INDEX: ["WRITE"],
    // Managing brokers/lanes/drop-lots requires REGIONAL_MANAGER+.
    REFERENCE_DATA: ["READ", "WRITE"]
  },
  CORPORATE_OPS: {
    BOARD: ["READ", "WRITE"],
    KPI_DASHBOARD: ["READ", "WRITE"],
    RATE_CONFIRMATION_UPLOAD: ["WRITE"],
    RATE_CONFIRMATION_REVIEW: ["READ", "REVIEW"],
    FSC_INDEX: ["WRITE"],
    REFERENCE_DATA: ["READ", "WRITE"]
  },
  ADMIN: {
    BOARD: ["READ", "WRITE"],
    KPI_DASHBOARD: ["READ", "WRITE"],
    RATE_CONFIRMATION_UPLOAD: ["WRITE"],
    RATE_CONFIRMATION_REVIEW: ["READ", "REVIEW"],
    FSC_INDEX: ["WRITE"],
    REFERENCE_DATA: ["READ", "WRITE"],
    // Managing the LLM provider/API key is ADMIN-only.
    SYSTEM_SETTINGS: ["READ", "WRITE"]
  }
};

export function isPermissionAllowed(role: Role, permission: PolicyPermission): boolean {
  const allowedActions = permissionMatrix[role]?.[permission.resource] ?? [];
  return allowedActions.includes(permission.action);
}

export function assertPermission(role: Role, permission: PolicyPermission): void {
  if (!isPermissionAllowed(role, permission)) {
    throw new PolicyViolationError(`Policy denies ${role} ${permission.action} on ${permission.resource}`);
  }
}

