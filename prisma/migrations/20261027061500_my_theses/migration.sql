-- AlterTable
ALTER TABLE "basket_constituents" ADD COLUMN     "realized_total" DECIMAL(16,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "baskets" ADD COLUMN     "action_preflight" JSONB,
ADD COLUMN     "cash" DECIMAL(16,4) NOT NULL DEFAULT 0,
ADD COLUMN     "closed_at" TIMESTAMPTZ(6),
ADD COLUMN     "contributed" DECIMAL(16,4) NOT NULL DEFAULT 0,
ADD COLUMN     "marked_at" TIMESTAMPTZ(6),
ADD COLUMN     "marks" JSONB,
ADD COLUMN     "simulated_moves" JSONB;

-- AlterTable
ALTER TABLE "executions" ADD COLUMN     "preflight_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "executions_preflight_id_key" ON "executions"("preflight_id");

-- Baskets deployed before this migration have only deploy fills, so their cost basis is what was contributed.
UPDATE "baskets" b
SET "contributed" = coalesce((SELECT sum(c."cost_total") FROM "basket_constituents" c WHERE c."basket_id" = b."id"), 0);
