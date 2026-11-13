import { describe, expect, it } from "vitest";
import { normName, sameCompany } from "@/lib/name-match";
import { fromQbo, resetSandboxBook, sandboxBook, sandboxQboClient, toQboJournalEntry, toQboPayment, toQboSalesDoc } from "@/server/partners/adapters/quickbooks";

/** The QuickBooks adapter's pure half and its simulator (docs/MONEY_PLAN.md, Wave 3): matching names, building bodies in dollars from cents, and the refusals the real company makes. */
describe("matching a company by name (rule D)", () => {
  it("ignores case, punctuation, & against and, and the legal ending; nothing else", () => {
    expect(normName("ACME LOGISTICS, LLC")).toBe("acme logistics");
    expect(normName("Acme Logistics Inc.")).toBe("acme logistics");
    expect(normName("Harbor & Pine Freight Co")).toBe("harbor and pine freight");
    expect(normName("Acme Logistics West")).not.toBe(normName("Acme Logistics"));
    const list = [{ name: "ACME LOGISTICS, LLC", companyName: null }, { name: "Acme Logistics West", companyName: null }, { name: "AL", companyName: "Acme Logistics Inc" }];
    expect(sameCompany("Acme Logistics", list).map((c) => c.name)).toEqual(["ACME LOGISTICS, LLC", "AL"]);
    expect(sameCompany("", list)).toEqual([]);
  });
});

describe("QuickBooks bodies", () => {
  it("are built in dollars from cents, with refs by id", () => {
    expect(toQboSalesDoc({ docNumber: "INV-1", txnDate: "2026-11-02", dueDate: "2026-12-02", customerId: "7", lines: [{ amount: 100050, itemId: "3", description: "Linehaul" }] })).toEqual({
      DocNumber: "INV-1",
      TxnDate: "2026-11-02",
      DueDate: "2026-12-02",
      CustomerRef: { value: "7" },
      Line: [{ Amount: 1000.5, Description: "Linehaul", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "3" } } }]
    });
    expect(toQboPayment({ customerId: "7", txnDate: "2026-11-20", total: 0, depositAccountId: null, reference: null, links: [{ id: "9", type: "Invoice", amount: 20000 }, { id: "12", type: "CreditMemo", amount: 20000 }] })).toMatchObject({ TotalAmt: 0, Line: [{ Amount: 200 }, { Amount: 200 }] });
    expect(fromQbo("Payment", { Id: "4", SyncToken: "2", TotalAmt: 12.34, Line: [{ Amount: 12.34, LinkedTxn: [{ TxnId: "9", TxnType: "Invoice" }] }] })).toMatchObject({ id: "4", syncToken: "2", total: 1234, links: [{ id: "9", type: "Invoice", amount: 1234 }], status: "active" });
  });
});

describe("the QuickBooks simulator", () => {
  const auth = { accessToken: "sandbox_access_unit", realmId: "R1", tenant: "unit" };
  const at = "2026-11-20T18:00:00.000Z";
  const send = (req: Parameters<typeof sandboxQboClient.send>[2]) => sandboxQboClient.send(auth, at, req);

  it("refuses a token it did not give, a stale SyncToken, a duplicate name or number, an unbalanced entry, and paying more than is open", async () => {
    resetSandboxBook("R1", "unit");
    const b = sandboxBook("R1", "unit", at);
    const acct = (n: string) => String([...b.objects.get("Account")!.values()].find((a) => a.Name === n)!.Id);
    await expect(sandboxQboClient.send({ ...auth, accessToken: "real-token" }, at, { op: "list", entity: "Account" })).rejects.toMatchObject({ code: "3200", status: 401 });
    await expect(send({ op: "create", entity: "Customer", body: { DisplayName: "acme logistics, llc" } })).rejects.toMatchObject({ code: "6240" });
    const [cust] = await send({ op: "create", entity: "Customer", body: { DisplayName: "Pine Freight" } });
    const [item] = await send({ op: "create", entity: "Item", body: { Name: "Linehaul", Type: "Service", IncomeAccountRef: { value: acct("Freight Income") } } });
    const doc = toQboSalesDoc({ docNumber: "X-1", txnDate: "2026-11-20", customerId: String(cust!.obj.Id), lines: [{ amount: 50000, itemId: String(item!.obj.Id), description: "Linehaul" }] });
    const [inv] = await send({ op: "create", entity: "Invoice", body: doc });
    await expect(send({ op: "create", entity: "Invoice", body: doc })).rejects.toMatchObject({ code: "6140" });
    await expect(send({ op: "update", entity: "Invoice", id: String(inv!.obj.Id), syncToken: "7", body: doc })).rejects.toMatchObject({ code: "5010" });
    await expect(send({ op: "create", entity: "Payment", body: toQboPayment({ customerId: String(cust!.obj.Id), txnDate: "2026-11-20", total: 60000, depositAccountId: null, reference: null, links: [{ id: String(inv!.obj.Id), type: "Invoice", amount: 60000 }] }) })).rejects.toMatchObject({ code: "6000" });
    await expect(send({ op: "create", entity: "JournalEntry", body: toQboJournalEntry({ docNumber: "J", txnDate: "2026-11-20", lines: [{ posting: "Debit", amount: 100, accountId: acct("Fuel"), description: "x" }, { posting: "Credit", amount: 99, accountId: acct("Fuel Card Payable"), description: "x" }] }) })).rejects.toMatchObject({ code: "6000" });
    // A payment applied, then voided: the invoice is open again, and the change feed has both.
    const [pay] = await send({ op: "create", entity: "Payment", body: toQboPayment({ customerId: String(cust!.obj.Id), txnDate: "2026-11-20", total: 50000, depositAccountId: null, reference: null, links: [{ id: String(inv!.obj.Id), type: "Invoice", amount: 50000 }] }) });
    await expect(send({ op: "void", entity: "Invoice", id: String(inv!.obj.Id), syncToken: "0" })).rejects.toMatchObject({ code: "6480" });
    await sandboxQboClient.send(auth, "2026-11-21T00:00:00.000Z", { op: "void", entity: "Payment", id: String(pay!.obj.Id), syncToken: "0" });
    expect([...b.objects.get("Invoice")!.values()][0]!.Balance).toBe(500);
    const changed = await send({ op: "changes", entities: ["Payment"], since: "2026-11-20T20:00:00.000Z" });
    expect(changed.map((c) => [c.obj.Id, c.obj.status])).toEqual([[pay!.obj.Id, "voided"]]);
    resetSandboxBook("R1", "unit");
  });
});
