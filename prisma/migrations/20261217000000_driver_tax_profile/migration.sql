-- Driver tax profile (docs/MONEY_PLAN.md, Wave 4 step 2). Additive. What a contractor's 1099 needs from the desk: the legal name, whether the number is an SSN or an EIN, its last four
-- digits, whether the payroll company has collected or verified it, and the mailing address. The full SSN or EIN is never stored here: it lives with the payroll company, and the desk keeps
-- the last four to match it. The checks below make the database refuse anything longer than four digits, whatever writes it.

ALTER TABLE "drivers" ADD COLUMN "legal_name" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tin_type" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tin_last4" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tin_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "drivers" ADD COLUMN "tax_address_line1" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tax_address_line2" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tax_city" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tax_state" TEXT;
ALTER TABLE "drivers" ADD COLUMN "tax_zip" TEXT;

ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tin_last4_check" CHECK ("tin_last4" IS NULL OR "tin_last4" ~ '^[0-9]{4}$');
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tin_type_check" CHECK ("tin_type" IS NULL OR "tin_type" IN ('ssn', 'ein'));
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tin_status_check" CHECK ("tin_status" IN ('none', 'collected', 'verified'));
