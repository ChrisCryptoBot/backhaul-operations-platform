-- The Leak Read intake (docs/LEAK_LEDGER.md): the carrier's own cost per mile (fleet default, optionally per truck) and detention terms (fleet default, optionally per customer), kept as one document on the
-- workspace. Imported history has no frozen floor and no frozen detention terms, so the Leak ledger prices it from these figures and labels every such line "intake, not frozen at booking".
-- Seeds nothing; null means the intake has not been filled in.

ALTER TABLE "workspaces" ADD COLUMN "leak_intake" JSONB;
