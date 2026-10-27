-- CreateTable
CREATE TABLE "account_snapshots" (
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "balances" JSONB NOT NULL,
    "positions" JSONB NOT NULL,
    "data_as_of" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_snapshots_pkey" PRIMARY KEY ("user_id","account_id")
);

-- CreateIndex
CREATE INDEX "api_calls_account_hash_created_at_idx" ON "api_calls"("account_hash", "created_at");

-- AddForeignKey
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (not expressible in schema.prisma): no policies, so
-- Supabase's anon/authenticated roles get nothing; the app connects as owner.
ALTER TABLE "account_snapshots" ENABLE ROW LEVEL SECURITY;
