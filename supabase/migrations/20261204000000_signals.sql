-- Generated from prisma/migrations/20261204000000_signals/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Stored signals and the notification ledger (docs/SIGNALS.md). A signal is an alert the desk derives on every request, kept: when it was first seen, whether someone acknowledged it, when it cleared.
-- A notification row is the DB-level guarantee that one thing is sent once: a unique key per desk. Seeds nothing; nothing is sent until a channel is configured.

CREATE TABLE "signals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "load_id" TEXT,
  "load_number" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "first_seen_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "reopen_count" INTEGER NOT NULL DEFAULT 0,
  "acked_by" TEXT,
  "acked_at" TIMESTAMP(3),
  "last_level_sent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "signals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signals_status_check" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT "signals_level_check" CHECK ("level" IN ('block', 'warn', 'info'))
);
CREATE UNIQUE INDEX "signals_workspace_id_key_key" ON "signals"("workspace_id", "key");
CREATE INDEX "signals_workspace_id_status_level_idx" ON "signals"("workspace_id", "status", "level");
CREATE INDEX "signals_load_id_idx" ON "signals"("load_id");
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "notification_log" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "signal_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_try_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_log_state_check" CHECK ("state" IN ('queued', 'sent', 'failed', 'skipped')),
  CONSTRAINT "notification_log_kind_check" CHECK ("kind" IN ('signal', 'weekly_report'))
);
-- One row per thing and channel per desk, whatever races: the second insert of the same dedupe key fails instead of sending twice.
CREATE UNIQUE INDEX "notification_log_workspace_id_dedupe_key_key" ON "notification_log"("workspace_id", "dedupe_key");
CREATE INDEX "notification_log_workspace_id_state_idx" ON "notification_log"("workspace_id", "state");
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What is sent and when the weekly report goes (null = the built-in default: block alerts only, Monday 7 AM on the carrier clock, report on).
ALTER TABLE "workspaces" ADD COLUMN "signal_min_level" TEXT,
ADD COLUMN "report_day" INTEGER,
ADD COLUMN "report_hour" INTEGER,
ADD COLUMN "report_enabled" BOOLEAN;
