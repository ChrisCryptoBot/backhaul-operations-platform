-- Loads, phone parity: itemised trip costs, a revenue note, the cancel note and TONU miles, and the stop a proof of delivery belongs to. All nullable; nothing existing changes.
ALTER TABLE "loads" ADD COLUMN "expense_items" JSONB;
ALTER TABLE "loads" ADD COLUMN "revenue_note" TEXT;
ALTER TABLE "loads" ADD COLUMN "cancel_note" TEXT;
ALTER TABLE "loads" ADD COLUMN "tonu_miles" DECIMAL(12,4);
ALTER TABLE "load_documents" ADD COLUMN "stop_id" TEXT;
