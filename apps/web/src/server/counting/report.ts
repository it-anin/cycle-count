/**
 * รายงานผลต่างทั้งรอบนับ สำหรับหน้าแอดมินและการส่งออก Excel
 *
 * ต่างจาก `variance.ts` ที่คำนวณเฉพาะ SKU ที่เพิ่งส่งขึ้นมาเพื่อเฉลยให้คนนับ —
 * ไฟล์นี้เอา **ทุก SKU ที่มีคนนับในรอบนี้** ไม่ว่าจะตรงหรือไม่ตรง
 *
 * ยังไม่รวม SKU ที่มียอดตั้งต้นแต่ไม่มีใครเดินไปนับเลย เพราะระหว่างรอบยังนับไม่จบ
 * การเอามาแสดงว่า "ขาดทั้งหมด" จะทำให้อ่านไม่ออก — ไว้ทำตอนปิดรอบค่อยว่ากัน
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { countLines, countSessions, expectedStock, products, uomConversions } from '@cycle-count/db';

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
  rows: ReportRow[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function sessionReport(sessionId: string): Promise<SessionReport | null> {
  const [session] = await db
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

  if (!session) return null;

  /*
   * ยอดที่นับได้ต่อ SKU ในหน่วยฐาน รวมทุกคนที่นับ SKU นั้น
   * เก็บรายชื่อคนนับกับเวลาล่าสุดมาด้วย เพราะแอดมินต้องตามตัวคนที่นับผิดได้
   *
   * sku เป็น null ได้ (ยิงแล้วไม่พบใน master) — group ด้วย line_key แทน
   * ไม่งั้น Postgres จะยุบของที่ไม่รู้จักทุกตัวรวมเป็นแถวเดียว
   */
  const counted = await db
    .select({
      sku: countLines.sku,
      lineKey: countLines.lineKey,
      scannedBarcode: sql<string>`max(${countLines.scannedBarcode})`,
      baseQty: sql<string>`sum(${countLines.countedQty} * ${countLines.factorToBase})`,
      flagged: sql<boolean>`bool_or(${countLines.flagged})`,
      lastAt: sql<string>`max(${countLines.countedAt})`,
      counters: sql<string[]>`array_agg(DISTINCT ${countLines.countedBy}::text)`,
    })
    .from(countLines)
    .where(eq(countLines.sessionId, sessionId))
    .groupBy(countLines.sku, countLines.lineKey);

  /* ยุบหลายหน่วยของ SKU เดียวกันให้เหลือแถวเดียว — หน้าจอคิดเป็นราย SKU */
  const bySku = new Map<
    string,
    { sku: string | null; label: string; base: number; flagged: boolean; last: string | null; who: Set<string> }
  >();

  for (const row of counted) {
    const key = row.sku ?? row.lineKey;
    const prev = bySku.get(key);
    const who = prev?.who ?? new Set<string>();
    for (const c of row.counters ?? []) who.add(c);

    bySku.set(key, {
      sku: row.sku,
      label: row.sku ?? (row.scannedBarcode || row.lineKey),
      base: (prev?.base ?? 0) + Number(row.baseQty),
      flagged: (prev?.flagged ?? false) || Boolean(row.flagged),
      last:
        !prev?.last || (row.lastAt && row.lastAt > prev.last) ? (row.lastAt ?? prev?.last ?? null) : prev.last,
      who,
    });
  }

  const skus = [...bySku.values()].map((v) => v.sku).filter((s): s is string => Boolean(s));

  const expectedRows = skus.length
    ? await db
        .select({
          sku: expectedStock.sku,
          baseQty: sql<string>`sum(${expectedStock.expectedQty} * coalesce(${uomConversions.factorToBase}, 1))`,
        })
        .from(expectedStock)
        .leftJoin(
          uomConversions,
          and(eq(uomConversions.sku, expectedStock.sku), eq(uomConversions.uom, expectedStock.uom)),
        )
        .where(and(eq(expectedStock.sessionId, sessionId), inArray(expectedStock.sku, skus)))
        .groupBy(expectedStock.sku)
    : [];

  const productRows = skus.length
    ? await db
        .select({
          sku: products.sku,
          name: products.name,
          baseUom: products.baseUom,
          location: products.location,
        })
        .from(products)
        .where(inArray(products.sku, skus))
    : [];

  const expectedCount = (await db.execute(sql`
    SELECT count(DISTINCT sku)::int AS n
    FROM cycle_count.expected_stock WHERE session_id = ${sessionId}::uuid
  `)) as unknown as { n: number }[];
  const expectedSkus = Number(expectedCount[0]?.n ?? 0);

  /** ชื่อคนนับอ่านง่ายกว่า uuid — ดึงมาแปลงทีเดียว */
  const profileRows = (await db.execute(sql`
    SELECT user_id::text AS id, employee_code FROM cycle_count.profiles
  `)) as unknown as { id: string; employee_code: string }[];
  const nameOf = new Map(profileRows.map((p) => [p.id, p.employee_code]));

  const expectedBySku = new Map(expectedRows.map((r) => [r.sku, Number(r.baseQty)]));
  const productBySku = new Map(productRows.map((r) => [r.sku, r]));

  const totals: ReportTotals = {
    match: 0, short: 0, over: 0, unknown: 0,
    counted: bySku.size,
    expectedSkus,
    diffValue: 0,
  };

  const rows: ReportRow[] = [];

  for (const v of bySku.values()) {
    const product = v.sku ? productBySku.get(v.sku) : undefined;
    const countedBaseQty = round4(v.base);
    const expectedRaw = v.sku ? expectedBySku.get(v.sku) : undefined;
    const expectedBaseQty = v.flagged || expectedRaw === undefined ? null : round4(expectedRaw);
    const diff = expectedBaseQty === null ? null : round4(countedBaseQty - expectedBaseQty);

    let kind: VarianceKind;
    if (v.flagged || diff === null) kind = 'unknown';
    else if (diff === 0) kind = 'match';
    else kind = diff < 0 ? 'short' : 'over';

    totals[kind] += 1;

    rows.push({
      sku: v.sku,
      name: product?.name ?? (v.flagged ? 'ไม่พบใน master' : v.label),
      location: product?.location ?? null,
      baseUom: product?.baseUom ?? '',
      expectedBaseQty,
      countedBaseQty,
      diff,
      // ยังไม่ได้ต่อ price list — เว้นไว้ให้หน้าจอแสดงขีด ไม่ใช่แสดง 0 ซึ่งจะเข้าใจผิดว่าไม่มีผลต่าง
      diffValue: null,
      kind,
      counters: [...v.who].map((id) => nameOf.get(id) ?? id.slice(0, 8)),
      lastCountedAt: v.last,
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
    rows,
  };
}
