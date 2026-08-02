/**
 * โครงสำหรับเทส integration ที่ต้องใช้ Postgres จริง
 *
 * ## ทำไมยิงใส่ DB จริง ไม่ใช่ Postgres ใน Docker
 *
 * `syncCatalog()` / `snapshotExpected()` อ่านจาก `public.stock` · `public.products` ·
 * `public.product_master` ซึ่งเป็นตารางของระบบ POS ที่เราไม่ได้เป็นเจ้าของ
 * ถ้าสร้างตารางปลอมขึ้นมาใน Docker เอง เราจะเทสกับ **สมมติฐานของตัวเอง**
 * ไม่ใช่ของจริง — ซึ่งเป็นคนละเรื่องกับกับดักที่โดนมาแล้ว (`__probe__`, `qty` เป็น text,
 * หลายสาขาปนกัน) กับดักพวกนั้นจะโผล่ก็ต่อเมื่อเจอข้อมูลจริงเท่านั้น
 *
 * ## กติกาที่ทำให้ปลอดภัยพอจะยิงใส่ DB จริง
 *
 * 1. **อ่านอย่างเดียวจาก `public.*`** — ไม่มีเทสไหนเขียนลง schema ของ POS
 * 2. **เขียนเฉพาะภายใต้ session ที่เทสสร้างเอง** ซึ่งมี prefix `__TEST__` ในคอลัมน์ `code`
 * 3. **ลบทิ้งเสมอใน finally** — `count_sessions` มี FK CASCADE ไป `expected_stock`
 *    และ `count_lines` ลบ session ตัวเดียวจึงเก็บกวาดครบ
 * 4. **ห้ามเรียก `syncCatalog()`** — มันเขียนทับ master data ที่ทุกรอบนับใช้ร่วมกัน
 *    ไม่ได้ scope กับ session ใดเลย ถ้าจะเทสต้องแยกไปทำมือ
 *
 * ## วิธีรัน
 *
 *   pnpm --filter @cycle-count/web test:integration
 *
 * ไม่รวมอยู่ใน `pnpm test` ปกติ เพราะต้องมี `.env` ที่ต่อ DB ได้จริง
 * CI จึงไม่รันชุดนี้ (ดู .github/workflows/ci.yml)
 */
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db';

/** ทุก session ที่เทสสร้างต้องขึ้นต้นด้วยคำนี้ เพื่อให้กวาดทิ้งได้แน่นอน */
export const TEST_PREFIX = '__TEST__';

export interface TestSession {
  id: string;
  code: string;
}

/**
 * สร้างรอบนับชั่วคราวสำหรับเทสหนึ่งข้อ
 * คืน id มาให้ใช้ แล้วต้องเรียก `dropTestSession()` ใน finally เสมอ
 */
export async function createTestSession(mode: 'blind' | 'recount' = 'blind'): Promise<TestSession> {
  const code = `${TEST_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const rows = (await db.execute(sql`
    INSERT INTO cycle_count.count_sessions (code, name, mode, status)
    VALUES (${code}, ${'เทส integration'}, ${mode}::cycle_count.count_mode, 'draft')
    RETURNING id
  `)) as unknown as { id: string }[];

  const id = rows[0]?.id;
  if (!id) throw new Error('สร้าง session สำหรับเทสไม่สำเร็จ');

  return { id, code };
}

/** ลบรอบนับของเทสทิ้ง — CASCADE จะพา expected_stock กับ count_lines ไปด้วย */
export async function dropTestSession(session: TestSession): Promise<void> {
  await db.execute(sql`DELETE FROM cycle_count.count_sessions WHERE id = ${session.id}::uuid`);
}

/**
 * กวาด session ของเทสที่ค้างจากรอบก่อน (เช่นเทสถูกฆ่ากลางคัน)
 * เรียกครั้งเดียวตอนเริ่มชุดเทส
 */
export async function sweepLeftoverTestSessions(): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM cycle_count.count_sessions WHERE code LIKE ${TEST_PREFIX + '%'}
  `);
  return (res as unknown as { count?: number; length?: number }).count ?? 0;
}

/** สาขาที่มีของมากที่สุดใน public.stock — ใช้เป็นสาขาตั้งต้นของเทส */
export async function busiestBranches(limit = 2): Promise<{ branch: string; skuCount: number }[]> {
  const rows = (await db.execute(sql`
    SELECT s.branch, count(DISTINCT btrim(s.sku))::int AS sku_count
    FROM public.stock s
    WHERE btrim(s.sku) <> '__probe__' AND btrim(s.branch) <> '__probe__'
    GROUP BY s.branch
    HAVING count(DISTINCT btrim(s.sku)) > 0
    ORDER BY count(DISTINCT btrim(s.sku)) DESC
    LIMIT ${limit}
  `)) as unknown as { branch: string; sku_count: number }[];

  return rows.map((r) => ({ branch: r.branch, skuCount: r.sku_count }));
}

/** จำนวนแถว expected_stock ของรอบหนึ่ง */
export async function countExpected(sessionId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM cycle_count.expected_stock WHERE session_id = ${sessionId}::uuid
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** SKU ทั้งหมดที่อยู่ใน expected_stock ของรอบหนึ่ง */
export async function expectedSkus(sessionId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT sku FROM cycle_count.expected_stock WHERE session_id = ${sessionId}::uuid
  `)) as unknown as { sku: string }[];
  return new Set(rows.map((r) => r.sku));
}
