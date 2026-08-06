/**
 * รายงานผลต่างทั้งรอบนับ สำหรับหน้าแอดมินและการส่งออก Excel
 *
 * ต่างจาก `variance.ts` ที่คำนวณเฉพาะ SKU ที่เพิ่งส่งขึ้นมาเพื่อเฉลยให้คนนับ —
 * ไฟล์นี้เอา **ทุก SKU ที่มีคนนับในรอบนี้** ไม่ว่าจะตรงหรือไม่ตรง
 *
 * ยังไม่รวม SKU ที่มียอดตั้งต้นแต่ไม่มีใครเดินไปนับเลย เพราะระหว่างรอบยังนับไม่จบ
 * การเอามาแสดงว่า "ขาดทั้งหมด" จะทำให้อ่านไม่ออก — ไว้ทำตอนปิดรอบค่อยว่ากัน
 */
import { eq, sql } from 'drizzle-orm';

import { countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';

export type VarianceKind = 'match' | 'short' | 'over' | 'unknown';

export interface ReportRow {
  /** null = ยิงแล้วไม่พบใน master */
  sku: string | null;
  name: string;
  location: string | null;
  baseUom: string;
  expectedBaseQty: number | null;
  countedBaseQty: number;
  diff: number | null;
  /** มูลค่าผลต่าง — null เมื่อยังไม่มีราคาของ SKU นี้ในรอบ */
  diffValue: number | null;
  kind: VarianceKind;
  counters: string[];
  lastCountedAt: string | null;
}

export interface ReportTotals {
  match: number;
  short: number;
  over: number;
  unknown: number;
  /** SKU ทั้งหมดที่มีคนนับแล้วในรอบนี้ */
  counted: number;
  /** SKU ที่มียอดตั้งต้นในรอบนี้ ใช้เป็นตัวหารความคืบหน้า */
  expectedSkus: number;
  diffValue: number;
}

/**
 * สถิติของคนนับหนึ่งคนในรอบนี้
 *
 * ตั้งใจให้เป็น "ทำไปเท่าไร" ไม่ใช่ "ผิดกี่ตัว" — ผลต่างเป็นของ SKU ไม่ใช่ของคน
 * ถ้าสองคนนับ SKU เดียวกัน ผลต่างที่ออกมาเป็นของทั้งคู่รวมกัน จะโยนให้ใครคนหนึ่งไม่ได้
 * อยากดูผลต่างเฉพาะที่คนหนึ่งไปยุ่งด้วย ให้กรองตารางด้วยชื่อคนนั้นแทน
 */
export interface CounterStat {
  employeeCode: string;
  name: string;
  /** จำนวน SKU (นับของที่ไม่รู้จักเป็นรายการหนึ่งด้วย) */
  skus: number;
  /** จำนวนบรรทัด — SKU เดียวยิงสองหน่วยนับเป็น 2 */
  lines: number;
  baseQty: number;
  lastCountedAt: string | null;
}

export interface SessionReport {
  session: {
    id: string;
    code: string;
    name: string;
    mode: 'blind' | 'recount';
    status: 'draft' | 'active' | 'closed';
    location: string | null;
    sourceBranch: string | null;
    snapshotAt: string | null;
    closedAt: string | null;
  };
  totals: ReportTotals;
  /** เรียงจากคนที่นับมากสุด — ว่างเมื่อยังไม่มีใครนับ */
  counterStats: CounterStat[];
  rows: ReportRow[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function sessionReport(sessionId: string): Promise<SessionReport | null> {
  /*
   * ทุก query ด้านล่างรู้ sessionId ตั้งแต่ต้น จึงยิงพร้อมกันใน network phase เดียว
   * แถวรายงานรวมยอดตั้งต้น + product + รหัสพนักงานใน Postgres เลย ไม่ส่ง SKU
   * หลายพันตัวกลับมาสร้าง IN (...) แล้วยิง query รอบสองเหมือนเดิม
   */
  const [sessionRows, reportRows, expectedCount, perCounter] = await Promise.all([
    db
      .select({
        id: countSessions.id,
        code: countSessions.code,
        name: countSessions.name,
        mode: countSessions.mode,
        status: countSessions.status,
        location: countSessions.location,
        sourceBranch: countSessions.sourceBranch,
        snapshotAt: countSessions.snapshotAt,
        closedAt: countSessions.closedAt,
      })
      .from(countSessions)
      .where(eq(countSessions.id, sessionId))
      .limit(1),
    db.execute(sql`
      WITH counted AS (
        SELECT coalesce(cl.sku, cl.line_key) AS row_key,
               cl.sku,
               max(coalesce(cl.scanned_barcode, cl.line_key)) AS label,
               sum(cl.counted_qty * cl.factor_to_base)::float8 AS counted_base_qty,
               bool_or(cl.flagged) AS flagged,
               max(cl.counted_at) AS last_counted_at,
               array_agg(
                 DISTINCT coalesce(pf.employee_code, left(cl.counted_by::text, 8))
               ) AS counters
        FROM cycle_count.count_lines cl
        LEFT JOIN cycle_count.profiles pf ON pf.user_id = cl.counted_by
        WHERE cl.session_id = ${sessionId}::uuid
        GROUP BY coalesce(cl.sku, cl.line_key), cl.sku
      ),
      expected AS (
        SELECT e.sku,
               sum(e.expected_qty * coalesce(u.factor_to_base, 1))::float8 AS expected_base_qty
        FROM cycle_count.expected_stock e
        JOIN counted c ON c.sku = e.sku
        LEFT JOIN cycle_count.uom_conversions u ON u.sku = e.sku AND u.uom = e.uom
        WHERE e.session_id = ${sessionId}::uuid
        GROUP BY e.sku
      )
      SELECT c.sku,
             c.label,
             c.counted_base_qty,
             c.flagged,
             c.last_counted_at,
             c.counters,
             p.name,
             p.location,
             p.base_uom,
             e.expected_base_qty
      FROM counted c
      LEFT JOIN cycle_count.products p ON p.sku = c.sku
      LEFT JOIN expected e ON e.sku = c.sku
    `) as unknown as Promise<
      {
        sku: string | null;
        label: string;
        counted_base_qty: number;
        flagged: boolean;
        last_counted_at: Date | string | null;
        counters: string[];
        name: string | null;
        location: string | null;
        base_uom: string | null;
        expected_base_qty: number | null;
      }[]
    >,
    db.execute(sql`
      SELECT count(DISTINCT sku)::int AS n
      FROM cycle_count.expected_stock WHERE session_id = ${sessionId}::uuid
    `) as unknown as Promise<{ n: number }[]>,
    db.execute(sql`
      SELECT coalesce(p.employee_code, left(cl.counted_by::text, 8)) AS employee_code,
             coalesce(p.name, '(ไม่พบชื่อ)') AS name,
             count(DISTINCT coalesce(cl.sku, cl.line_key))::int AS skus,
             count(*)::int AS lines,
             sum(cl.counted_qty * cl.factor_to_base)::float8 AS base,
             max(cl.counted_at) AS last_at
      FROM cycle_count.count_lines cl
      LEFT JOIN cycle_count.profiles p ON p.user_id = cl.counted_by
      WHERE cl.session_id = ${sessionId}::uuid
      GROUP BY cl.counted_by, p.employee_code, p.name
    `) as unknown as Promise<
      {
        employee_code: string;
        name: string;
        skus: number;
        lines: number;
        base: number;
        last_at: Date | string | null;
      }[]
    >,
  ]);

  const session = sessionRows[0];
  if (!session) return null;

  const expectedSkus = Number(expectedCount[0]?.n ?? 0);

  const counterStats: CounterStat[] = perCounter
    .map((c) => ({
      employeeCode: c.employee_code,
      name: c.name,
      skus: Number(c.skus),
      lines: Number(c.lines),
      baseQty: round4(Number(c.base ?? 0)),
      lastCountedAt: c.last_at ? new Date(c.last_at).toISOString() : null,
    }))
    .sort((a, b) => b.skus - a.skus);

  const totals: ReportTotals = {
    match: 0,
    short: 0,
    over: 0,
    unknown: 0,
    counted: reportRows.length,
    expectedSkus,
    diffValue: 0,
  };

  const rows: ReportRow[] = [];

  for (const row of reportRows) {
    const countedBaseQty = round4(Number(row.counted_base_qty));
    const expectedBaseQty =
      row.flagged || row.expected_base_qty === null ? null : round4(Number(row.expected_base_qty));
    const diff = expectedBaseQty === null ? null : round4(countedBaseQty - expectedBaseQty);

    let kind: VarianceKind;
    if (row.flagged || diff === null) kind = 'unknown';
    else if (diff === 0) kind = 'match';
    else kind = diff < 0 ? 'short' : 'over';

    totals[kind] += 1;

    rows.push({
      sku: row.sku,
      name: row.name ?? (row.flagged ? 'ไม่พบใน master' : row.label),
      location: row.location,
      baseUom: row.base_uom ?? '',
      expectedBaseQty,
      countedBaseQty,
      diff,
      // ยังไม่ได้ต่อ price list — เว้นไว้ให้หน้าจอแสดงขีด ไม่ใช่แสดง 0 ซึ่งจะเข้าใจผิดว่าไม่มีผลต่าง
      diffValue: null,
      kind,
      counters: row.counters ?? [],
      lastCountedAt: row.last_counted_at ? new Date(row.last_counted_at).toISOString() : null,
    });
  }

  /* ผิดมากสุดขึ้นก่อน ตามด้วยของที่ต้องตรวจ แล้วค่อยตัวที่ตรง */
  const order: Record<VarianceKind, number> = { short: 0, over: 1, unknown: 2, match: 3 };
  rows.sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    return Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0);
  });

  return {
    session: {
      ...session,
      snapshotAt: session.snapshotAt ? session.snapshotAt.toISOString() : null,
      closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    },
    totals,
    counterStats,
    rows,
  };
}
