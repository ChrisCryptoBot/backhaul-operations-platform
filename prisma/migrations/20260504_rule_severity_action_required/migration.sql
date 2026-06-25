DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'RuleSeverity'
      AND e.enumlabel = 'BLOCK'
  ) THEN
    ALTER TYPE "RuleSeverity" RENAME VALUE 'BLOCK' TO 'ACTION_REQUIRED';
  END IF;
END $$;
