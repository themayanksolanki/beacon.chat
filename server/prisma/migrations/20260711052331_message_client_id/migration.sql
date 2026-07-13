/*
  Warnings:

  - Added the required column `client_id` to the `messages` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "client_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "messages_client_id_idx" ON "messages"("client_id");
