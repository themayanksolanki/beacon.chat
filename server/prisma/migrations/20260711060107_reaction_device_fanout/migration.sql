/*
  Warnings:

  - The primary key for the `reactions` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `recipient_device_id` to the `reactions` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "reactions_recipient_id_delivered_at_idx";

-- AlterTable
ALTER TABLE "reactions" DROP CONSTRAINT "reactions_pkey",
ADD COLUMN     "recipient_device_id" TEXT NOT NULL,
ADD CONSTRAINT "reactions_pkey" PRIMARY KEY ("message_id", "sender_id", "recipient_device_id");

-- CreateIndex
CREATE INDEX "reactions_recipient_device_id_delivered_at_idx" ON "reactions"("recipient_device_id", "delivered_at");

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_recipient_device_id_fkey" FOREIGN KEY ("recipient_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
