-- Wave 5 (front-end reconciliation): requests for an account. Under 50 trucks is self-serve; 50 or more is an enterprise request a person follows up and sets up.
-- A request is not tied to a workspace (none exists yet); workspace_id is filled in when one is made for it.

CREATE TABLE "signup_requests" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "trucks" INTEGER NOT NULL,
  "mc_number" TEXT,
  "best_time" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "workspace_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "signup_requests_status_kind_created_at_idx" ON "signup_requests"("status", "kind", "created_at");
