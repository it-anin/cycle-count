/**
 * ดึงข้อมูลจากระบบสต็อกเดิมใน schema `public` เข้ามาที่ `cycle_count`
 *
 * มีสองงานที่ต่างกันชัดเจน:
 *
 *  1. syncCatalog()  — master data (SKU / บาร์โค้ด / หน่วย) ดึงทับได้บ่อยเท่าที่ต้องการ
 *  2. snapshotExpected() — ยอดตั้งต้น **ถ่ายครั้งเดียวตอนเปิดรอบ แล้วแช่แข็ง**
 *
 * ข้อสองสำคัญมาก: ตาราง public.stock ถูกอัปเดตทุก 5 นาที ถ้าอ่านสดตอนคำนวณผลต่าง
 * ของที่ถูกเบิกไประหว่างที่พนักงานเดินไปนับจะกลายเป็น "ของหาย" แยกไม่ออกจากของหายจริง
 * และรายงานเดิมจะให้ตัวเลขไม่เท่ากันทุกครั้งที่เปิดดู ผู้ตรวจสอบบัญชีรับไม่ได้
 *
 * ระบบเดิมเก็บตัวเลขเป็น text ทั้งหมด และมีแถว sentinel `__probe__` ปนอยู่
 * ทุก query ในไฟล์นี้จึงต้องกันสองเรื่องนั้นเสมอ
 */
import { sql } from 'drizzle-orm';

import { PROBE_SKU } from '@cycle-count/db';

import { db } from '@/lib/db';
import { withMasterCatalogWrite, withSessionCatalogWrite } from '@/server/catalog/version';

/**
 * แปลง text เป็น numeric แบบไม่ระเบิด
 *
 * `'369.0000'::numeric` ใช้ได้ แต่เจอ `''`, `'-'`, `'N/A'` เมื่อไหร่ทั้ง statement ล้ม
 * และ snapshot ของทั้งรอบนับก็พังไปด้วย — กันด้วย regex ก่อน cast
 */
const numericOrZero = (col: string) =>
  sql.raw(
    `CASE WHEN btrim(${col}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN btrim(${col})::numeric ELSE 0 END`,
  );

/** เงื่อนไขกรองแถวขยะที่ใช้ร่วมกันทุก query */
const CLEAN_ROWS = sql.raw(`
  s.sku IS NOT NULL
  AND btrim(s.sku) <> ''
  AND btrim(s.sku) <> '${PROBE_SKU}'
  AND btrim(s.branch) <> '${PROBE_SKU}'
`);

export interface SyncCatalogResult {
  products: number;
  barcodes: number;
  uomConversions: number;
}

/**
 * ดึง master data เข้ามา — เรียกก่อน snapshotExpected() เสมอ
 * เพราะ expected_stock มี FK ไปที่ cycle_count.products.sku
 *
 * แหล่งข้อมูล:
 *   public.products       หนึ่งแถว = หนึ่งบาร์โค้ด → cycle_count.barcodes
 *   public.product_master ข้อมูลสินค้าละเอียด      → cycle_count.products + uom_conversions
 */
export async function syncCatalog(): Promise<SyncCatalogResult> {
  return withMasterCatalogWrite(async (tx) => {
    // 1) สินค้า — เอา product_master เป็นหลัก แล้วเติมด้วย SKU ที่มีเฉพาะใน products
    const products = await tx.execute(sql`
    INSERT INTO cycle_count.products (sku, name, base_uom, category, updated_at)
    SELECT
      btrim(m.sku),
      COALESCE(NULLIF(btrim(m.name), ''), NULLIF(btrim(m.sku_name), ''), btrim(m.sku)),
      COALESCE(NULLIF(btrim(m.base_unit), ''), 'PCS'),
      NULLIF(btrim(m.group_name), ''),
      now()
    FROM public.product_master m
    WHERE m.sku IS NOT NULL
      AND btrim(m.sku) <> ''
      AND btrim(m.sku) <> ${PROBE_SKU}
    ON CONFLICT (sku) DO UPDATE SET
      name = excluded.name,
      base_uom = excluded.base_uom,
      category = excluded.category,
      updated_at = now()
  `);

    const extraProducts = await tx.execute(sql`
    INSERT INTO cycle_count.products (sku, name, base_uom, updated_at)
    SELECT DISTINCT ON (btrim(p.sku))
      btrim(p.sku),
      COALESCE(NULLIF(btrim(p.name), ''), btrim(p.sku)),
      COALESCE(NULLIF(btrim(p.unit), ''), 'PCS'),
      now()
    FROM public.products p
    WHERE p.sku IS NOT NULL
      AND btrim(p.sku) <> ''
      AND btrim(p.sku) <> ${PROBE_SKU}
    ORDER BY btrim(p.sku), p.updated_at DESC NULLS LAST
    ON CONFLICT (sku) DO NOTHING
  `);

    /*
     * 2) หน่วยฐานของแต่ละ SKU — เอาจาก barcode_units ที่ตัวคูณ = 1
     *
     *    เชื่อไฟล์ R05106 มากกว่า product_master.base_unit เพราะเป็นแหล่งเดียวกับตัวคูณ
     *    ตรวจกับไฟล์จริงแล้วทุก SKU มีหน่วยตัวคูณ = 1 เสมอ (0 SKU ที่ไม่มี)
     *    บาง SKU มีสองบาร์โค้ดที่ตัวคูณ = 1 (หน่วยเดียวกัน คนละบาร์โค้ด) — DISTINCT ON เลือกให้แน่นอน
     */
    const baseUnits = await tx.execute(sql`
    UPDATE cycle_count.products cp
    SET base_uom = b.uom, updated_at = now()
    FROM (
      SELECT DISTINCT ON (sku) sku, uom
      FROM cycle_count.barcode_units
      WHERE factor_to_base = 1
      ORDER BY sku, barcode
    ) b
    WHERE cp.sku = b.sku AND cp.base_uom <> b.uom
  `);

    /*
     * 3) บาร์โค้ด — barcode_units เป็นแหล่งหลักเพราะมีตัวคูณติดมาด้วย
     *    public.products ไม่มีตัวคูณ ใช้เติมเฉพาะบาร์โค้ดที่ไม่มีในไฟล์ (ตัวคูณถือเป็น 1)
     */
    const barcodesFromUnits = await tx.execute(sql`
    INSERT INTO cycle_count.barcodes (barcode, sku, uom)
    SELECT bu.barcode, bu.sku, bu.uom
    FROM cycle_count.barcode_units bu
    JOIN cycle_count.products cp ON cp.sku = bu.sku
    ON CONFLICT (barcode) DO UPDATE SET sku = excluded.sku, uom = excluded.uom
  `);

    const barcodesFromProducts = await tx.execute(sql`
    INSERT INTO cycle_count.barcodes (barcode, sku, uom)
    SELECT DISTINCT ON (btrim(p.barcode))
      btrim(p.barcode),
      btrim(p.sku),
      COALESCE(NULLIF(btrim(p.unit), ''), cp.base_uom)
    FROM public.products p
    JOIN cycle_count.products cp ON cp.sku = btrim(p.sku)
    WHERE p.barcode IS NOT NULL
      AND btrim(p.barcode) <> ''
      AND p.sku IS NOT NULL
      AND btrim(p.sku) <> ''
    ORDER BY btrim(p.barcode), p.updated_at DESC NULLS LAST
    ON CONFLICT (barcode) DO NOTHING
  `);

    /*
     * 4) การแปลงหน่วย — ตัวคูณรายบาร์โค้ดจาก R05106
     *
     *    product_master.multiply ใช้ไม่ได้เพราะเก็บได้ค่าเดียวต่อ SKU
     *    แต่ของจริง SKU หนึ่งมีได้หลายหน่วยที่ตัวคูณต่างกัน
     *    เช่น 100098 = แผง(1) / 10แผง(10) / โหล(12) / กล่อง(50)
     */
    const uomFromUnits = await tx.execute(sql`
    INSERT INTO cycle_count.uom_conversions (sku, uom, factor_to_base)
    SELECT DISTINCT ON (bu.sku, bu.uom) bu.sku, bu.uom, bu.factor_to_base
    FROM cycle_count.barcode_units bu
    JOIN cycle_count.products cp ON cp.sku = bu.sku
    ORDER BY bu.sku, bu.uom, bu.barcode
    ON CONFLICT (sku, uom) DO UPDATE SET factor_to_base = excluded.factor_to_base
  `);

    /*
     * 5) หน่วยที่โผล่ที่อื่นแต่ไม่มีในไฟล์ตัวคูณ — ใส่ 1 ไว้ก่อน
     *    หน่วยฐานเองก็ต้องมีแถว factor = 1 ด้วย ไม่งั้น snapshot คูณไม่ได้
     *    ใช้ DO NOTHING เพื่อไม่ทับค่าจริงจาก R05106
     */
    const uomFallback = await tx.execute(sql`
    INSERT INTO cycle_count.uom_conversions (sku, uom, factor_to_base)
    SELECT sku, uom, 1 FROM (
      SELECT sku, base_uom AS uom FROM cycle_count.products
      UNION
      SELECT sku, uom FROM cycle_count.barcodes
      UNION
      SELECT DISTINCT btrim(s.sku), COALESCE(NULLIF(btrim(s.unit), ''), 'PCS')
      FROM public.stock s
      WHERE btrim(s.sku) <> ${PROBE_SKU}
    ) needed
    WHERE EXISTS (SELECT 1 FROM cycle_count.products cp WHERE cp.sku = needed.sku)
    ON CONFLICT (sku, uom) DO NOTHING
  `);

    return {
      products: rowCount(products) + rowCount(extraProducts) + rowCount(baseUnits),
      barcodes: rowCount(barcodesFromUnits) + rowCount(barcodesFromProducts),
      uomConversions: rowCount(uomFromUnits) + rowCount(uomFallback),
    };
  });
}

export interface SnapshotResult {
  rows: number;
  snapshotAt: Date;
  /** SKU ที่มียอดใน public.stock แต่ไม่มีใน master — ต้องให้แอดมินตาม */
  skippedUnknownSkus: number;
}

/**
 * ถ่ายยอดคงเหลือของสาขาหนึ่ง ณ วินาทีนี้ เข้าเป็นยอดตั้งต้นของรอบนับ
 *
 * เรียกครั้งเดียวตอนเปิดรอบ เรียกซ้ำจะทับของเดิมและ **เลื่อน cut-off** —
 * ทำได้เฉพาะตอนที่รอบยังไม่มีใครนับ
 */
export async function snapshotExpected(sessionId: string, branch: string): Promise<SnapshotResult> {
  return withSessionCatalogWrite(sessionId, async (tx) => {
    const snapshotAt = new Date();

    /*
     * รวมยอดด้วย SUM เผื่อสาขาเดียวกันมีหลายแถวต่อ sku+unit
     * (สคริปต์ sync อาจ append ไม่ได้ replace) — ถ้าไม่รวมจะชน PK ของ expected_stock
     */
    const inserted = await tx.execute(sql`
    INSERT INTO cycle_count.expected_stock (session_id, sku, uom, expected_qty)
    SELECT
      ${sessionId}::uuid,
      btrim(s.sku),
      COALESCE(NULLIF(btrim(s.unit), ''), cp.base_uom),
      SUM(${numericOrZero('s.qty')})
    FROM public.stock s
    JOIN cycle_count.products cp ON cp.sku = btrim(s.sku)
    WHERE s.branch = ${branch}
      AND ${CLEAN_ROWS}
    GROUP BY btrim(s.sku), COALESCE(NULLIF(btrim(s.unit), ''), cp.base_uom)
    ON CONFLICT (session_id, sku, uom) DO UPDATE SET expected_qty = excluded.expected_qty
  `);

    // SKU ที่มีของแต่ไม่รู้จัก — ไม่ควรเงียบ เพราะแปลว่า master ไม่ครบ
    const unknown = await tx.execute(sql`
    SELECT count(DISTINCT btrim(s.sku))::int AS n
    FROM public.stock s
    LEFT JOIN cycle_count.products cp ON cp.sku = btrim(s.sku)
    WHERE s.branch = ${branch}
      AND ${CLEAN_ROWS}
      AND cp.sku IS NULL
  `);

    await tx.execute(sql`
    UPDATE cycle_count.count_sessions
    SET snapshot_at = ${snapshotAt.toISOString()}::timestamptz,
        expected_source = 'public.stock',
        source_branch = ${branch}
    WHERE id = ${sessionId}::uuid
  `);

    return {
      rows: rowCount(inserted),
      snapshotAt,
      skippedUnknownSkus: Number((unknown as unknown as { n: number }[])[0]?.n ?? 0),
    };
  });
}

/** รายชื่อสาขาที่มีในระบบสต็อก ให้แอดมินเลือกตอนเปิดรอบ */
export async function listBranches(): Promise<{ branch: string; skuCount: number }[]> {
  const rows = await db.execute(sql`
    SELECT s.branch, count(DISTINCT btrim(s.sku))::int AS sku_count
    FROM public.stock s
    WHERE ${CLEAN_ROWS}
    GROUP BY s.branch
    ORDER BY s.branch
  `);

  return (rows as unknown as { branch: string; sku_count: number }[]).map((r) => ({
    branch: r.branch,
    skuCount: r.sku_count,
  }));
}

/** postgres-js คืน array ที่มี .count ติดมา — Drizzle ไม่ได้ normalize ให้ */
function rowCount(result: unknown): number {
  const r = result as { count?: number; length?: number };
  return r.count ?? r.length ?? 0;
}
