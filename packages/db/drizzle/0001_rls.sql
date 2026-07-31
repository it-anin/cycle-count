-- Row Level Security — เฉพาะ schema cycle_count เท่านั้น
--
-- ⚠ ทุกชื่อตารางในไฟล์นี้ต้อง qualify ด้วย "cycle_count". เสมอ
-- โปรเจกต์ Supabase นี้ใช้ร่วมกับระบบอื่นที่มีข้อมูล production อยู่ใน public
-- ถ้าเผลอเขียน ALTER TABLE "products" เฉย ๆ จะไปเปิด RLS ทับตารางของระบบนั้น
-- ซึ่งไม่มี policy รองรับ = ปฏิเสธทุก query = ระบบเขาล่มทันที
--
-- หมายเหตุ: Drizzle ต่อ Postgres ด้วย DATABASE_URL ซึ่งเป็น role `postgres` และ BYPASSRLS
-- policy ชุดนี้จึงไม่มีผลกับ query ที่ผ่าน route handler — การตรวจสิทธิ์จริงอยู่ที่
-- apps/web/src/server/auth.ts นี่เป็นเกราะชั้นสองกรณี anon key หลุด

-- ── helper ────────────────────────────────────────────────────────────────
-- วางไว้ใน cycle_count ไม่ใช่ public จะได้ไม่ไปชนชื่อฟังก์ชันของระบบอื่น

CREATE OR REPLACE FUNCTION cycle_count.cc_is_active_user() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cycle_count, public AS $$
    SELECT EXISTS (
      SELECT 1 FROM cycle_count.profiles
      WHERE user_id = auth.uid() AND active
    );
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cycle_count.cc_is_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cycle_count, public AS $$
    SELECT EXISTS (
      SELECT 1 FROM cycle_count.profiles
      WHERE user_id = auth.uid() AND active AND role = 'admin'
    );
  $$;
--> statement-breakpoint

-- ── เปิด RLS ทุกตารางของเรา ────────────────────────────────────────────────
-- ไม่มี policy = ปฏิเสธหมด ตารางที่ไม่ได้ประกาศ policy ด้านล่างจึงเข้าถึงไม่ได้เลย

ALTER TABLE "cycle_count"."products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."barcodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."uom_conversions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."price_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."prices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."count_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."expected_stock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."count_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count"."import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── master data: พนักงานที่ยัง active อ่านได้ แก้ไขได้เฉพาะแอดมิน ──────────

CREATE POLICY "products_read" ON "cycle_count"."products"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "products_write" ON "cycle_count"."products"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

CREATE POLICY "barcodes_read" ON "cycle_count"."barcodes"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "barcodes_write" ON "cycle_count"."barcodes"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

CREATE POLICY "uom_read" ON "cycle_count"."uom_conversions"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "uom_write" ON "cycle_count"."uom_conversions"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

ALTER TABLE "cycle_count"."barcode_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "barcode_units_read" ON "cycle_count"."barcode_units"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "barcode_units_write" ON "cycle_count"."barcode_units"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

-- ── ราคา: แอดมินเท่านั้น พนักงานนับไม่ต้องเห็นราคา ─────────────────────────

CREATE POLICY "price_lists_admin" ON "cycle_count"."price_lists"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

CREATE POLICY "prices_admin" ON "cycle_count"."prices"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

-- ── profiles: เห็นของตัวเอง แอดมินเห็นและแก้ได้ทุกคน ───────────────────────

CREATE POLICY "profiles_read_self" ON "cycle_count"."profiles"
  FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "profiles_admin" ON "cycle_count"."profiles"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

-- ── รอบนับและยอดตั้งต้น: อ่านได้ทุกคนที่ active แก้ได้เฉพาะแอดมิน ──────────

CREATE POLICY "sessions_read" ON "cycle_count"."count_sessions"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "sessions_write" ON "cycle_count"."count_sessions"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

CREATE POLICY "expected_read" ON "cycle_count"."expected_stock"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());--> statement-breakpoint
CREATE POLICY "expected_write" ON "cycle_count"."expected_stock"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

-- ── ผลนับ: เขียนได้เฉพาะของตัวเอง และเฉพาะรอบที่ยังเปิดอยู่ ────────────────

CREATE POLICY "count_lines_read" ON "cycle_count"."count_lines"
  FOR SELECT TO authenticated USING (counted_by = auth.uid() OR cycle_count.cc_is_admin());--> statement-breakpoint

CREATE POLICY "count_lines_insert" ON "cycle_count"."count_lines"
  FOR INSERT TO authenticated WITH CHECK (
    counted_by = auth.uid()
    AND cycle_count.cc_is_active_user()
    AND EXISTS (
      SELECT 1 FROM cycle_count.count_sessions s
      WHERE s.id = session_id AND s.status = 'active'
    )
  );--> statement-breakpoint

CREATE POLICY "count_lines_update" ON "cycle_count"."count_lines"
  FOR UPDATE TO authenticated
  USING (
    counted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM cycle_count.count_sessions s
      WHERE s.id = session_id AND s.status = 'active'
    )
  )
  WITH CHECK (counted_by = auth.uid());--> statement-breakpoint

CREATE POLICY "count_lines_admin" ON "cycle_count"."count_lines"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());--> statement-breakpoint

-- ── ประวัติการนำเข้า: แอดมินเท่านั้น ──────────────────────────────────────

CREATE POLICY "import_batches_admin" ON "cycle_count"."import_batches"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());
