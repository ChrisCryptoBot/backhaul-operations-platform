-- Row level security on for every table in public, with no policies.
-- Supabase publishes every public table through its REST API; with row security off, anyone holding the project's anon key could read loads, driver pay and customer rates.
-- With it on and no policies, that door is closed. The desk's own server connects through Prisma as the owning postgres role, which is not subject to it, so the desk is unaffected.
-- Idempotent. Run it again after applying any later migration (a new table starts with row security off).
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;
