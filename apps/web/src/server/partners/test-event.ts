import { prisma } from "@/lib/db";
import { WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { randomBytes } from "node:crypto";
import { keyMode } from "./adapters/sandbox";
import { sandboxFactoringEvent } from "./adapters/triumphpay";
import { workspaceReader } from "./credentials";
import { syncEld } from "./eld";
import { factorInvoice } from "./factoring";
import { handleWebhook } from "./webhook";

/**
 * "Send test event": the demo's one-click proof that the plumbing works, from Settings, with no terminal. It only exists for a company whose keys run the built-in simulator, and it never leaves
 * the desk: the event is built in the company's own shape, signed with the fleet's own signing secret, and handed to the same receiver a real company's post would reach (token, signature on the
 * raw bytes, one record per event id, applied through the rules a person's hand uses). So what the investor sees move is the real path, not a shortcut around it.
 *   factoring  walks the newest invoice one step at a time: sent to the factor, then funded, then paid.
 *   eld        reads the simulated hours and positions now, instead of waiting for the schedule.
 *   others     a signed test ping, which proves the address, the secret and the signature.
 */
export type TestEventResult = { ok: true; what: string; result: string; loadId: string | null } | { ok: false; error: string };

const fail = (error: string): TestEventResult => ({ ok: false, error });

export async function sendTestEvent(capability: string, provider: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TestEventResult> {
  const conn = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  if (!conn || (conn.status !== "connected" && conn.status !== "error")) return fail("Connect it first.");
  const reader = await workspaceReader(provider, workspaceId);
  if (keyMode(provider, reader) !== "sandbox") return fail("Test events are only for the built-in simulator. Use a key that starts with sandbox_.");

  if (capability === "eld") {
    const out = await syncEld(now, workspaceId);
    if (!out.ok) return fail(out.error);
    return { ok: true, what: "Read hours of service and positions from the simulated ELD", result: `${out.synced} ${out.synced === 1 ? "tractor" : "tractors"} updated${out.linked > 0 ? `, ${out.linked} newly linked` : ""}`, loadId: null };
  }

  const secretName = WEBHOOK_SECRET_ENV[provider];
  const secret = secretName ? reader(secretName) : undefined;
  if (!secret) return fail("Save the webhook signing secret first (any text that starts with sandbox_).");
  if (!conn.webhookToken) return fail("This connection has no webhook address yet. Disconnect and connect it again.");
  const id = `evt_test_${randomBytes(6).toString("hex")}`;

  if (capability === "factoring") {
    // The newest invoice that is with the factor moves on one step; with none, the newest delivered invoice is sent to the (simulated) factor first.
    const moving = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, factoringStatus: { in: ["submitted", "funded"] } }, orderBy: { factoringUpdatedAt: "desc" } });
    if (!moving) {
      const ready = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, status: "completed", paymentStatus: "invoiced", factoringStatus: { in: ["none", "rejected"] } }, orderBy: { invoicedAt: "desc" } });
      if (!ready) return fail("There is no invoice to send. Deliver a load and invoice it, then try again.");
      const sent = await factorInvoice(ready.id, { sendAnyway: true }, now, workspaceId);
      if (!sent.ok) return fail(sent.error);
      return { ok: true, what: `Sent ${ready.invoiceNumber ?? ready.loadNumber ?? "the invoice"} to the simulated factor`, result: `with the factor, reference ${sent.referenceId}`, loadId: ready.id };
    }
    const kind = moving.factoringStatus === "submitted" ? "factoring.funded" : "factoring.paid";
    const event = sandboxFactoringEvent({ kind, invoiceNumber: moving.invoiceNumber, referenceId: moving.factoringReferenceId, amount: moving.invoicedAmount != null ? num(moving.invoicedAmount) : undefined, id, secret, now });
    const answer = await handleWebhook({ provider, token: conn.webhookToken, raw: event.raw, signature: event.signature, now });
    if (answer.status !== 200 || !answer.body.ok) return fail("The desk's own receiver refused the test event.");
    return { ok: true, what: `Signed ${kind === "factoring.funded" ? "funding" : "payment"} event delivered for ${moving.invoiceNumber ?? moving.loadNumber ?? "the invoice"}`, result: `the desk answered: ${answer.body.result}`, loadId: moving.id };
  }

  const event = sandboxFactoringEvent({ kind: "ping", invoiceNumber: null, referenceId: null, id, secret, now });
  const answer = await handleWebhook({ provider, token: conn.webhookToken, raw: event.raw, signature: event.signature, now });
  if (answer.status !== 200 || !answer.body.ok) return fail("The desk's own receiver refused the test ping.");
  return { ok: true, what: "Signed test ping delivered", result: `the desk answered: ${answer.body.result}`, loadId: null };
}
