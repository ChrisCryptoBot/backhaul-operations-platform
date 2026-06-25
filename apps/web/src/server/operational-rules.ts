import { runInRegionScope } from "@/lib/db";
import { withNonDeletedRegionScope } from "@/lib/scoped-query";
import { createAuditLog } from "@/lib/audit";

/**
 * Operational rules (region governance statements surfaced on the KPI dashboard).
 * Read + create extracted so both the /api/rules route and the copilot tools
 * share one path. RBAC (KPI_DASHBOARD:WRITE) is enforced by the caller.
 */

export type RuleSeverity = "INFO" | "WARN" | "ACTION_REQUIRED";

export interface OperationalRuleSummary {
  id: string;
  code: string;
  severity: RuleSeverity;
  title: string;
  statement: string;
  appliesTo: string;
}

export async function listOperationalRules(input: { regionId: string }): Promise<OperationalRuleSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const rules = await tx.operationalRule.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: { code: "asc" },
      select: { id: true, code: true, severity: true, statement: true, metadata: true }
    });
    return rules.map((rule) => {
      const metadata = (rule.metadata ?? {}) as Record<string, unknown>;
      return {
        id: rule.id,
        code: rule.code,
        severity: rule.severity as RuleSeverity,
        title: typeof metadata.title === "string" ? metadata.title : rule.code,
        statement: rule.statement,
        appliesTo: typeof metadata.appliesTo === "string" ? metadata.appliesTo : "Region"
      };
    });
  });
}

export async function createOperationalRule(input: {
  regionId: string;
  actorId: string;
  code: string;
  title: string;
  severity: RuleSeverity;
  statement: string;
  appliesTo?: string;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const rule = await tx.operationalRule.create({
      data: {
        regionId: input.regionId,
        code: input.code,
        severity: input.severity,
        statement: input.statement,
        metadata: { title: input.title, appliesTo: input.appliesTo ?? "Region" }
      },
      select: { id: true, code: true, severity: true }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "OperationalRule",
        entityId: rule.id,
        action: "CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: { code: rule.code, severity: rule.severity, title: input.title }
      })
    });
    return { id: rule.id };
  });
}
