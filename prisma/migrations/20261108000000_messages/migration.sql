-- Wave 4 (front-end reconciliation): the desk's Messages. One thread per driver, messages in it, optionally about a load.
-- Nothing carries a message to a driver's phone yet, so delivered_at stays empty and the screen says so.

CREATE TABLE "threads" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "load_id" TEXT,
  "client_id" TEXT,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(3),
  "read_at" TIMESTAMP(3),
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "threads_driver_id_key" ON "threads"("driver_id");
CREATE INDEX "threads_workspace_id_last_message_at_idx" ON "threads"("workspace_id", "last_message_at");
CREATE UNIQUE INDEX "messages_thread_id_client_id_key" ON "messages"("thread_id", "client_id");
CREATE INDEX "messages_thread_id_sent_at_idx" ON "messages"("thread_id", "sent_at");
CREATE INDEX "messages_direction_read_at_idx" ON "messages"("direction", "read_at");

ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
