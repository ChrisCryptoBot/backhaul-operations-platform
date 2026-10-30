import { prisma } from "@/lib/db";
import { validateCompany, type Company, type CompanyCheck, type CompanyValues } from "@/lib/company";
import { recordAudit } from "./audit";
import { currentWorkspace, currentWorkspaceId } from "./workspace";

/** The company's identity for invoices and statements. Read by the sheets; saved from Settings with an audit entry listing what changed. */
type WorkspaceRow = { name: string; mcNumber: string | null; dotNumber: string | null; address: string | null; phone: string | null; email: string | null; remitTo: string | null; paymentNote: string | null };

export const toCompany = (w: WorkspaceRow): Company => ({ name: w.name, mcNumber: w.mcNumber, dotNumber: w.dotNumber, address: w.address, phone: w.phone, email: w.email, remitTo: w.remitTo, paymentNote: w.paymentNote });

export async function getCompany(workspaceId = currentWorkspaceId()): Promise<Company> {
  const w = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return toCompany(w);
}

const LABEL: Record<keyof Company, string> = { name: "Company name", mcNumber: "MC number", dotNumber: "DOT number", address: "Address", phone: "Phone", email: "Email", remitTo: "Remit payment to", paymentNote: "Payment note" };

export async function saveCompany(values: CompanyValues, now = new Date()): Promise<(CompanyCheck & { changed?: boolean }) | { ok: false; errors: Partial<Record<keyof CompanyValues, string>> }> {
  const check = validateCompany(values);
  if (!check.ok) return check;
  const ws = await currentWorkspace();
  const before = toCompany(ws);
  const keys = Object.keys(LABEL) as Array<keyof Company>;
  const changed = keys.filter((k) => (before[k] ?? null) !== (check.value[k] ?? null));
  if (changed.length === 0) return { ...check, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: ws.id }, data: check.value });
    await recordAudit(
      {
        entity: "settings",
        action: "company_changed",
        summary: `Company details changed: ${changed.map((k) => LABEL[k].toLowerCase()).join(", ")}`,
        before: Object.fromEntries(changed.map((k) => [LABEL[k], before[k]])),
        after: Object.fromEntries(changed.map((k) => [LABEL[k], check.value[k]])),
        at: now
      },
      tx
    );
  });
  return { ...check, changed: true };
}
