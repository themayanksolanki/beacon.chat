-- AlterTable
ALTER TABLE "reactions" ADD COLUMN     "sender_device_id" TEXT;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_sender_device_id_fkey" FOREIGN KEY ("sender_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
