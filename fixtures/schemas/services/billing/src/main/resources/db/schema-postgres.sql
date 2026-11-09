CREATE TABLE IF NOT EXISTS "public"."account" (
  "id" TEXT PRIMARY KEY,
  "owner" TEXT NOT NULL UNIQUE
);

CREATE TABLE "invoice" (
  "id" SERIAL PRIMARY KEY,
  "amount" NUMERIC(10, 2) NOT NULL DEFAULT 0,
  "account_id" TEXT REFERENCES "account" ON DELETE SET NULL,
  "issued" TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX "invoice_account_idx" ON "invoice" USING btree ("account_id");
ALTER TABLE "invoice" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "invoice" RENAME COLUMN "issued" TO "issued_at";
