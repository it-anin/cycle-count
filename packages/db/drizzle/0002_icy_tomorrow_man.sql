-- lease ของ import_batches + index สำหรับหน้าประวัติ
--
-- เพิ่มคอลัมน์อย่างเดียว ไม่แก้/ไม่ลบของเดิม โค้ดเวอร์ชันก่อนหน้าไม่รู้จักสองคอลัมน์นี้
-- แต่ก็ไม่พัง (nullable / มี default) จึง revert โค้ดอย่างเดียวโดยไม่ต้อง rollback DB ได้
--
-- rollback:
--   DROP INDEX  cycle_count.import_batches_status_created_idx;
--   ALTER TABLE cycle_count.import_batches DROP COLUMN processed_rows;
--   ALTER TABLE cycle_count.import_batches DROP COLUMN processing_started_at;

ALTER TABLE "cycle_count"."import_batches" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_count"."import_batches" ADD COLUMN "processed_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "import_batches_status_created_idx" ON "cycle_count"."import_batches" USING btree ("status","created_at" DESC NULLS LAST);