-- AlterTable
ALTER TABLE "events" ADD COLUMN     "guest_key" TEXT;

-- CreateIndex
CREATE INDEX "api_calls_created_at_idx" ON "api_calls"("created_at");

-- CreateIndex
CREATE INDEX "events_guest_key_created_at_idx" ON "events"("guest_key", "created_at");
