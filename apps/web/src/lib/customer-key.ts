/**
 * Who an invoice is billed to, as one comparable key: the name (trimmed, lower case, spaces collapsed) and the MC number's digits. Loads may share one invoice only when
 * their keys are equal (docs/MONEY_PLAN.md, rule G). Pure, so the screen that offers "Invoice these loads together" and the server that enforces it use one rule.
 */
export const MAX_LOADS_PER_INVOICE = 50;

export const customerKey =(l: { brokerName: string | null; brokerMcNumber: string | null }): string =>
  `${(l.brokerName ?? "").trim().toLowerCase().replace(/\s+/g, " ")}|${(l.brokerMcNumber ?? "").replace(/\D/g, "")}`;
