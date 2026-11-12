import { PrismaClient } from "@prisma/client";

/**
 * Database tests invoice and then delete their loads. An invoice number is held for good by its invoice record (docs/MONEY_PLAN.md, rule H: even when the load it was on has since been
 * removed), so a test that is run a second time would find its numbers taken. Before a run against the demo database, records left with no load at all (what a test's own clean-up leaves
 * behind) are deleted. The product never makes one: it only voids an invoice, and a load is only ever soft-deleted.
 */
export default async function setup(): Promise<void> {
  if (process.env.RUN_DB_INTEGRATION !== "true" || !process.env.DATABASE_URL) return;
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`delete from "invoices" i where i."kind" = 'invoice' and not exists (select 1 from "invoice_loads" il where il."invoice_id" = i."id")`);
    await prisma.$executeRawUnsafe(`delete from "invoices" c where c."kind" = 'credit_memo' and c."credit_of_id" is null`);
  } finally {
    await prisma.$disconnect();
  }
}
