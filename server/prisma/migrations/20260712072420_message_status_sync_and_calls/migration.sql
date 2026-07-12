-- CreateEnum
CREATE TYPE "CallKind" AS ENUM ('audio', 'video');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "delivered_synced_at" TIMESTAMP(3),
ADD COLUMN     "read_synced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "caller_id" TEXT NOT NULL,
    "callee_id" TEXT NOT NULL,
    "kind" "CallKind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMP(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_call_id_key" ON "calls"("call_id");

-- CreateIndex
CREATE INDEX "calls_callee_id_synced_at_idx" ON "calls"("callee_id", "synced_at");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
