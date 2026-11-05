-- Fuel card purchases deducted on driver statements (docs/PARTNER_BACKBONE.md): the draft's picks, the frozen ledger, and which statement each purchase was deducted on.
ALTER TABLE "settlements" ADD COLUMN "fuel_ids" JSONB,
ADD COLUMN "fuel" JSONB;

ALTER TABLE "fuel_transactions" ADD COLUMN "settlement_id" TEXT;
CREATE INDEX "fuel_transactions_settlement_id_idx" ON "fuel_transactions"("settlement_id");
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
