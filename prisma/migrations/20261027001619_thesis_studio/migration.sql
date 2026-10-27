-- CreateTable
CREATE TABLE "theses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "guest_client" TEXT,
    "account_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "preset_key" TEXT,
    "budget" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "overlap_mode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "llm_output" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "risk_profile" TEXT NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "theses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thesis_candidates" (
    "thesis_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "ticker" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "llm_weight" DOUBLE PRECISION,
    "resolution_status" TEXT NOT NULL,
    "detail" TEXT,
    "symbol" TEXT,
    "universal_symbol_id" TEXT,
    "price" DECIMAL(18,4),
    "price_source" TEXT,
    "overlap_value" DECIMAL(14,2),
    "adjusted_weight" DOUBLE PRECISION,
    "units" INTEGER,

    CONSTRAINT "thesis_candidates_pkey" PRIMARY KEY ("thesis_id","seq")
);

-- CreateIndex
CREATE INDEX "theses_user_id_created_at_idx" ON "theses"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "theses_prompt_hash_created_at_idx" ON "theses"("prompt_hash", "created_at");

-- AddForeignKey
ALTER TABLE "theses" ADD CONSTRAINT "theses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thesis_candidates" ADD CONSTRAINT "thesis_candidates_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "theses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (not expressible in schema.prisma): no policies, so
-- Supabase's anon/authenticated roles get nothing; the app connects as owner.
ALTER TABLE "theses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thesis_candidates" ENABLE ROW LEVEL SECURITY;
