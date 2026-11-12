/**
 * Factoring by batch (docs/MONEY_PLAN.md, Wave 2): how most factors actually take invoices. The desk hands over a set of files (a schedule of accounts as CSV and one PDF packet per invoice)
 * by SFTP or by email. This is the delivery side, in the same two layers as every adapter (./types.ts): a LIVE transport, which would open the SFTP session or send the email and does not
 * exist until a factor is chosen (it answers "not implemented"), and a SANDBOX transport, the simulator, which answers from inside the desk with no network call of any kind.
 *
 * The simulator is steered by the destination typed into the factoring terms, so a demo or a test can show each outcome on purpose:
 *   - a destination with "fail" in it is refused every time (a retryable failure: the factor's server refused the connection);
 *   - a destination with "flaky" in it is refused on the first try and accepted on the next (to show a retry going through);
 *   - anything else is accepted, with a receipt that names the batch.
 * Nothing under adapters/ opens a connection. A test fails if it ever does.
 */
export const BATCH_METHODS = ["sftp", "email"] as const;
export type BatchMethod = (typeof BATCH_METHODS)[number];
export const isBatchMethod = (v: unknown): v is BatchMethod => typeof v === "string" && (BATCH_METHODS as readonly string[]).includes(v);

export type BatchFile = { name: string; mime: string; bytes: Uint8Array };
export type BatchDelivery = { method: BatchMethod; destination: string; batchNumber: string; files: BatchFile[]; attempt: number };
export type DeliveryResult = { ok: true; receipt: string } | { ok: false; error: string; retryable: boolean; notLive?: boolean };
export type BatchTransport = { deliver(d: BatchDelivery): Promise<DeliveryResult> };

/** An email can carry about 25 MB, and attachments grow by a third when sent; this keeps a batch by email inside what a factor's mailbox accepts. SFTP has no such limit. */
export const EMAIL_BATCH_LIMIT_BYTES = 18 * 1024 * 1024;

export { destinationProblem } from "@/lib/factoring-terms";

/** The live transport: not written until a factor is chosen and gives its SFTP account or mailbox. */
export const liveBatchTransport: BatchTransport = {
  async deliver() {
    return { ok: false, error: "Sending batches to a factor by SFTP or email is not switched on yet: no factor's server or mailbox is set up. A sandbox_ key runs the simulator on the demo desk.", retryable: false, notLive: true };
  }
};

export const sandboxBatchTransport: BatchTransport = {
  async deliver(d) {
    const dest = d.destination.toLowerCase();
    if (dest.includes("fail")) return { ok: false, error: `The factor's ${d.method === "email" ? "mail server" : "SFTP server"} refused the delivery (simulated).`, retryable: true };
    if (dest.includes("flaky") && d.attempt < 2) return { ok: false, error: `The factor's ${d.method === "email" ? "mail server" : "SFTP server"} timed out (simulated); try again.`, retryable: true };
    const bytes = d.files.reduce((s, f) => s + f.bytes.length, 0);
    return { ok: true, receipt: `SBX-${d.method.toUpperCase()}-${d.batchNumber}-${d.files.length}F-${bytes}B` };
  }
};
