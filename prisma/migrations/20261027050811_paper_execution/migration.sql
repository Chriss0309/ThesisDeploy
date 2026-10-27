-- CreateTable
CREATE TABLE "baskets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_key" TEXT,
    "guest_client" TEXT,
    "thesis_id" UUID,
    "account_id" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "brokerage_slug" TEXT,
    "account_key" TEXT NOT NULL,
    "mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL,
    "budget" DECIMAL(14,2) NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "risk_profile" TEXT NOT NULL,
    "preflight" JSONB NOT NULL,
    "preflight_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployed_at" TIMESTAMPTZ(6),

    CONSTRAINT "baskets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "basket_constituents" (
    "basket_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "universal_symbol_id" TEXT,
    "company_name" TEXT NOT NULL,
    "target_weight" DOUBLE PRECISION NOT NULL,
    "planned_units" INTEGER NOT NULL,
    "ledger_units" INTEGER NOT NULL DEFAULT 0,
    "cost_total" DECIMAL(16,4) NOT NULL DEFAULT 0,

    CONSTRAINT "basket_constituents_pkey" PRIMARY KEY ("basket_id","symbol")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "basket_id" UUID NOT NULL,
    "account_key" TEXT NOT NULL,
    "active_account_key" TEXT,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "confirmation" JSONB NOT NULL,
    "simulate_reject_seq" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_legs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "execution_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "universal_symbol_id" TEXT,
    "units" INTEGER NOT NULL,
    "est_price" DECIMAL(18,4) NOT NULL,
    "client_order_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "not_before" TIMESTAMPTZ(6),
    "brokerage_order_id" TEXT,
    "snaptrade_status" TEXT,
    "filled_units" INTEGER,
    "fill_price" DECIMAL(18,4),
    "error_code" TEXT,
    "error_message" TEXT,
    "request_id" TEXT,
    "latency_ms" INTEGER,
    "claimed_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),

    CONSTRAINT "execution_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_pacing" (
    "account_key" TEXT NOT NULL,
    "last_submit_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pacing_pkey" PRIMARY KEY ("account_key")
);

-- CreateIndex
CREATE INDEX "baskets_user_id_created_at_idx" ON "baskets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "baskets_guest_key_created_at_idx" ON "baskets"("guest_key", "created_at");

-- CreateIndex
CREATE INDEX "baskets_guest_client_created_at_idx" ON "baskets"("guest_client", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "executions_active_account_key_key" ON "executions"("active_account_key");

-- CreateIndex
CREATE UNIQUE INDEX "executions_idempotency_key_key" ON "executions"("idempotency_key");

-- CreateIndex
CREATE INDEX "executions_basket_id_created_at_idx" ON "executions"("basket_id", "created_at");

-- CreateIndex
CREATE INDEX "execution_legs_execution_id_status_idx" ON "execution_legs"("execution_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "execution_legs_execution_id_seq_attempt_key" ON "execution_legs"("execution_id", "seq", "attempt");

-- AddForeignKey
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "theses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_constituents" ADD CONSTRAINT "basket_constituents_basket_id_fkey" FOREIGN KEY ("basket_id") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_basket_id_fkey" FOREIGN KEY ("basket_id") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_legs" ADD CONSTRAINT "execution_legs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (not expressible in schema.prisma): no policies, so
-- Supabase's anon/authenticated roles get nothing; the app connects as owner.
ALTER TABLE "baskets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "basket_constituents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_legs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_pacing" ENABLE ROW LEVEL SECURITY;
