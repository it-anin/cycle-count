/**
 * คำนวณผลต่างของรายการที่เพิ่งส่งขึ้นมา เพื่อเฉลยกลับให้เครื่อง PDA
 *
 * ทำที่ server เท่านั้นและเรียก **หลัง** บันทึกผลนับแล้ว — รอบ blind ไม่ส่งยอดระบบ
 * ลงเครื่องก่อนนับ ตัวเลขที่คนนับกรอกจึงถูกล็อกลง DB ไปก่อนที่จะเห็นเฉลย
 *
 * สองเรื่องที่ตั้งใจให้เป็นแบบนี้:
 *
 *  1. **เทียบเฉพาะ SKU ที่เพิ่งส่ง** ไม่ใช่ทั้งรอบนับ — ถ้าเทียบทั้งรอบ SKU อีกหกพันตัว
 *     ที่ยังไม่ได้เดินไปนับจะขึ้นว่า "ขาด" ทั้งหมด กลบของจริงจนอ่านไม่ออก
 *
 *  2. **รวมยอดของทุกคนที่นับ SKU นั้นในรอบเดียวกัน** ไม่ใช่เฉพาะของคนที่กดส่ง
 *     เพราะสองคนแบ่งโซนนับ SKU เดียวกันได้ ถ้าดูแค่ของตัวเองจะเห็นเป็น "ขาด"
 *     ทั้งที่รวมกันแล้วครบ — คำถามที่ต้องตอบคือ "ของในคลังตรงไหม" ไม่ใช่ "ฉันนับได้เท่าไร"
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { SubmitVariance, SubmitVarianceItem } from '@cycle-count/core';
import { countLines, expectedStock, products, uomConversions } from '@cycle-count/db';

import { db } from '@/lib/db';

/** ปัดเศษทศนิยมลอยตัวที่เกิดจากการคูณ factor ไม่ให้ 35.99999 กลายเป็น "ขาด" */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function varianceForSubmission(
  sessionId: string,
  skus: string[],
  unknownCount: number,
): Promise<SubmitVariance> {
  const empty: SubmitVariance = {
    matched: 0,
    short: 0,
    over: 0,
    unknown: unknownCount,
    withoutExpected: 0,
    items: [],
  };

  if (skus.length === 0) return empty;

  /* ยอดที่นับได้ในหน่วยฐาน รวมทุกคนที่นับ SKU นี้ในรอบเดียวกัน */
  const countedRows = await db
    .select({
      sku: countLines.sku,
      countedBase: sql<string>`sum(${countLines.countedQty} * ${countLines.factorToBase})`,
    })
    .from(countLines)
    .where(and(eq(countLines.sessionId, sessionId), inArray(countLines.sku, skus)))
    .groupBy(countLines.sku);

  /* ยอดตั้งต้นในหน่วยฐาน — expected_stock เก็บตามหน่วยของระบบต้นทาง ต้องคูณ factor ก่อนรวม */
  const expectedRows = await db
    .select({
      sku: expectedStock.sku,
      expectedBase: sql<string>`sum(${expectedStock.expectedQty} * coalesce(${uomConversions.factorToBase}, 1))`,
    })
    .from(expectedStock)
    .leftJoin(
      uomConversions,
      and(eq(uomConversions.sku, expectedStock.sku), eq(uomConversions.uom, expectedStock.uom)),
    )
    .where(and(eq(expectedStock.sessionId, sessionId), inArray(expectedStock.sku, skus)))
    .groupBy(expectedStock.sku);

  const productRows = await db
    .select({ sku: products.sku, name: products.name, baseUom: products.baseUom })
    .from(products)
    .where(inArray(products.sku, skus));

  const expectedBySku = new Map(expectedRows.map((r) => [r.sku, Number(r.expectedBase)]));
  const productBySku = new Map(productRows.map((r) => [r.sku, r]));

  const result: SubmitVariance = { ...empty, items: [] };

  for (const row of countedRows) {
    if (!row.sku) continue;

    const product = productBySku.get(row.sku);
    const countedBaseQty = round4(Number(row.countedBase));
    const expected = expectedBySku.get(row.sku);
    const expectedBaseQty = expected === undefined ? null : round4(expected);
    const diff = expectedBaseQty === null ? null : round4(countedBaseQty - expectedBaseQty);

    const item: SubmitVarianceItem = {
      sku: row.sku,
      name: product?.name ?? row.sku,
      baseUom: product?.baseUom ?? '',
      countedBaseQty,
      expectedBaseQty,
      diff,
    };

    if (diff === null) {
      result.withoutExpected += 1;
      result.items.push(item);
    } else if (diff === 0) {
      // ตรงแล้วไม่ต้องแสดงรายตัว นับรวมไว้เฉย ๆ ให้เห็นว่างานส่วนใหญ่เรียบร้อย
      result.matched += 1;
    } else if (diff < 0) {
      result.short += 1;
      result.items.push(item);
    } else {
      result.over += 1;
      result.items.push(item);
    }
  }

  /* ขาดมากสุดขึ้นก่อน — ตัวที่ห่างจากยอดระบบเยอะที่สุดคือตัวที่ต้องรีบไปดู */
  result.items.sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));

  return result;
}
