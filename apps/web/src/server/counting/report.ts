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
  /** SKU สำหรับของปกติ, line_key สำหรับบาร์โค้ดที่ไม่พบ — ใช้ merge ตอน refresh */
  key: string;
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
  /** เวลาฝั่ง server ก่อนเริ่ม query ใช้เป็น watermark ของ delta refresh รอบถัดไป */
  refreshedAt: string;
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

/** ผล refresh แบบ incremental — ส่งเฉพาะแถวที่แตะหลัง refreshedAt เดิม */
export interface SessionReportDelta {
  refreshedAt: string;
  session: SessionReport['session'];
  expectedSkus: number;
  counterStats: CounterStat[];
  rows: ReportRow[];
}

interface DatabaseReportRow {
  row_key: string;
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
}

interface DatabaseCounterStat {
  employee_code: string;
  name: string;
  skus: number;
  lines: number;
  base: number;
  last_at: Date | string | null;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function reportRowsQuery(
  sessionId: string,
  changedAfter: Date | null,
  refreshedAt: Date,
): Promise<DatabaseReportRow[]> {
  /*
   * full report ไม่ต้องมี join นี้ ส่วน delta หา key ที่เพิ่งถูก upsert ก่อน แล้วค่อย
   * รวมทุกบรรทัดของ key นั้นใหม่ เพื่อให้ยอดจากหลายคน/หลายหน่วยยังถูกต้อง
   */
  const changedJoin = changedAfter
    ? sql`
        JOIN (
          SELECT DISTINCT coalesce(sku, line_key) AS row_key
          FROM cycle_count.count_lines
          WHERE session_id = ${sessionId}::uuid
            -- ใช้ >= กัน timestamp ชน watermark พอดี; แถวซ้ำ merge ด้วย row_key ได้อย่างปลอดภัย
            AND updated_at >= ${changedAfter.toISOString()}::timestamptz
            AND updated_at <= ${refreshedAt.toISOString()}::timestamptz
        ) changed ON changed.row_key = coalesce(cl.sku, cl.line_key)
      `
    : sql``;

  return db.execute(sql`
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
      ${changedJoin}
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
    SELECT c.row_key,
           c.sku,
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
  `) as unknown as Promise<DatabaseReportRow[]>;
}

function expectedCountQuery(sessionId: string): Promise<{ n: number }[]> {
  return db.execute(sql`
    SELECT count(DISTINCT sku)::int AS n
    FROM cycle_count.expected_stock WHERE session_id = ${sessionId}::uuid
  `) as unknown as Promise<{ n: number }[]>;
}

function counterStatsQuery(sessionId: string): Promise<DatabaseCounterStat[]> {
  return db.execute(sql`
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
  `) as unknown as Promise<DatabaseCounterStat[]>;
}

function mapCounterStats(rows: DatabaseCounterStat[]): CounterStat[] {
  return rows
    .map((row) => ({
      employeeCode: row.employee_code,
      name: row.name,
      skus: Number(row.skus),
      lines: Number(row.lines),
      baseQty: round4(Number(row.base ?? 0)),
      lastCountedAt: row.last_at ? new Date(row.last_at).toISOString() : null,
    }))
    .sort((a, b) => b.skus - a.skus);
}

function mapReportRows(reportRows: DatabaseReportRow[]): ReportRow[] {
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

    rows.push({
      key: row.row_key,
      sku: row.sku,
      name: row.name ?? (row.flagged ? 'ไม่พบใน master' : row.label),
      location: row.location,
      baseUom: row.base_uom ?? '',
      expectedBaseQty,
      countedBaseQty,
      diff,
      diffValue: null,
      kind,
      counters: row.counters ?? [],
      lastCountedAt: row.last_counted_at ? new Date(row.last_counted_at).toISOString() : null,
    });
  }

  return rows;
}

function sortReportRows(rows: ReportRow[]): ReportRow[] {
  const order: Record<VarianceKind, number> = { short: 0, over: 1, unknown: 2, match: 3 };
  return rows.sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    return Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0);
  });
}

function serializeSession<
  T extends {
    snapshotAt: Date | null;
    closedAt: Date | null;
  },
>(
  session: T,
): Omit<T, 'snapshotAt' | 'closedAt'> & {
  snapshotAt: string | null;
  closedAt: string | null;
} {
  return {
    ...session,
    snapshotAt: session.snapshotAt ? session.snapshotAt.toISOString() : null,
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
  };
}

function sessionQuery(sessionId: string) {
  return db
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
    .limit(1);
}

function reportTotals(rows: ReportRow[], expectedSkus: number): ReportTotals {
  const totals: ReportTotals = {
    match: 0,
    short: 0,
    over: 0,
    unknown: 0,
    counted: rows.length,
    expectedSkus,
    diffValue: 0,
  };

  for (const row of rows) totals[row.kind] += 1;
  return totals;
}

export async function sessionReport(sessionId: string): Promise<SessionReport | null> {
  /*
   * จับ watermark ก่อนเริ่ม query ถ้ามีผลนับเข้าหลังเวลานี้ delta รอบถัดไปจะเก็บได้
   * แม้ full report รอบนี้กับการ upsert จาก PDA จะวิ่งชนกันพอดี
   */
  const refreshedAt = new Date();

  /*
   * ทุก query ด้านล่างรู้ sessionId ตั้งแต่ต้น จึงยิงพร้อมกันใน network phase เดียว
   * แถวรายงานรวมยอดตั้งต้น + product + รหัสพนักงานใน Postgres เลย ไม่ส่ง SKU
   * หลายพันตัวกลับมาสร้าง IN (...) แล้วยิง query รอบสองเหมือนเดิม
   */
  const [sessionRows, reportRows, expectedCount, perCounter] = await Promise.all([
    sessionQuery(sessionId),
    reportRowsQuery(sessionId, null, refreshedAt),
    expectedCountQuery(sessionId),
    counterStatsQuery(sessionId),
  ]);

  const session = sessionRows[0];
  if (!session) return null;

  const expectedSkus = Number(expectedCount[0]?.n ?? 0);
  const rows = sortReportRows(mapReportRows(reportRows));

  return {
    refreshedAt: refreshedAt.toISOString(),
    session: serializeSession(session),
    totals: reportTotals(rows, expectedSkus),
    counterStats: mapCounterStats(perCounter),
    rows,
  };
}

/**
 * โหลดเฉพาะ SKU ที่มี count_lines ถูก upsert หลัง watermark เดิม
 * ไม่มีการ polling — เรียกเฉพาะตอนผู้ใช้กดปุ่ม Refresh เท่านั้น
 */
export async function sessionReportDelta(
  sessionId: string,
  changedAfter: Date,
): Promise<SessionReportDelta | null> {
  const refreshedAt = new Date();
  const [sessionRows, reportRows, expectedCount, perCounter] = await Promise.all([
    sessionQuery(sessionId),
    reportRowsQuery(sessionId, changedAfter, refreshedAt),
    expectedCountQuery(sessionId),
    counterStatsQuery(sessionId),
  ]);

  const session = sessionRows[0];
  if (!session) return null;

  return {
    refreshedAt: refreshedAt.toISOString(),
    session: serializeSession(session),
    expectedSkus: Number(expectedCount[0]?.n ?? 0),
    counterStats: mapCounterStats(perCounter),
    rows: mapReportRows(reportRows),
  };
}
