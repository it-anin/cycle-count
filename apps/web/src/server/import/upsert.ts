/**
 * ชั้นเขียน master data ลง DB
 *
 * **ชั้นนี้ไม่รู้จัก Excel** รับแค่ typed rows ที่ผ่าน validate มาแล้ว
 * นั่นคือรอยต่อที่เตรียมไว้ให้ ERP:
 *
 *   Excel → parseRows()      ─┐
 *                             ├→ upsertX() → DB
 *   ERP   → mapErpPayload()  ─┘
 *
 * วันที่ต่อ ERP จะเพิ่มแค่ route ใหม่ที่ map payload แล้วเรียกฟังก์ชันในไฟล์นี้
 * ไม่ต้องรื้อ pipeline ของ Excel
 *
 * ทุกฟังก์ชันแบ่ง batch ละ 500 แถวตามแบบที่ packages/db/src/seed.ts ใช้ —
 * กัน statement ยาวเกินและกันหน่วยความจำบวมตอน import หมื่นแถว
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  BarcodeImportRow,
  ExpectedImportRow,
  PriceImportRow,
  ProductImportRow,
  UomImportRow,
} from '@cycle-count/core';
import {
  barcodes,
  expectedStock,
  priceLists,
  prices,
  products,
  uomConversions,
} from '@cycle-count/db';

import { db } from '@/lib/db';

const BATCH = 500;

function chunk<T>(rows: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * แถวซ้ำใน batch เดียวทำให้ ON CONFLICT DO UPDATE ล้ม
 * ("cannot affect row a second time") — ไฟล์ Excel จริงมี SKU ซ้ำได้เสมอ
 * เอาแถวหลังสุดชนะ ตามพฤติกรรมที่คนกรอกไฟล์คาดหวัง
 */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((r) => [key(r), r])).values()];
}

export interface UpsertResult {
  written: number;
}

/**
 * เรียกหลังเขียนแต่ละ batch สำเร็จ — ใช้รายงานความคืบหน้าให้หน้าเว็บเห็น
 * และทำให้ batch ที่ล้มกลางทางบอกได้ว่าเขียนไปถึงไหนแล้ว
 */
export type ProgressFn = (written: number) => Promise<void>;

/**
 * เขียนทีละ batch โดยแต่ละ batch อยู่ใน transaction ของตัวเอง
 *
 * **ทำไมไม่ห่อทั้งไฟล์ไว้ใน transaction เดียว**
 * ไฟล์จริงมีหมื่นแถว = ยี่สิบกว่า batch ใช้เวลาหลายสิบวินาที การถือ transaction
 * ไว้นานขนาดนั้นบน pgbouncer แบบ transaction pooling จะตรึง connection ทั้งเส้น
 * และเสี่ยงโดน `idle_in_transaction_session_timeout` ตัดกลางคัน
 *
 * batch ละ transaction จึงเป็นจุดสมดุล: ไฟล์ที่ล้มกลางทางจะได้ผลลัพธ์เป็น
 * "เขียนสำเร็จ N batch แรกครบถ้วน" ไม่ใช่ "batch สุดท้ายเขียนไปครึ่งเดียว"
 * และ `processed_rows` บอกได้ว่า N คือเท่าไร
 */
async function writeInBatches<T>(
  rows: T[],
  write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], part: T[]) => Promise<void>,
  onProgress?: ProgressFn,
): Promise<number> {
  let written = 0;

  for (const part of chunk(rows)) {
    await db.transaction(async (tx) => {
      await write(tx, part);
    });
    written += part.length;
    if (onProgress) await onProgress(written);
  }

  return written;
}

export async function upsertProducts(
  rows: ProductImportRow[],
  onProgress?: ProgressFn,
): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => r.sku);

  await writeInBatches(
    unique,
    async (tx, part) => {
      await tx
        .insert(products)
        .values(
          part.map((r) => ({
            sku: r.sku,
            name: r.name,
            baseUom: r.baseUom,
            category: r.category ?? null,
            location: r.location ?? null,
            active: r.active,
          })),
        )
        .onConflictDoUpdate({
          target: products.sku,
          set: {
            name: sql`excluded.name`,
            baseUom: sql`excluded.base_uom`,
            category: sql`excluded.category`,
            location: sql`excluded.location`,
            active: sql`excluded.active`,
            updatedAt: new Date(),
          },
        });
    },
    onProgress,
  );

  return { written: unique.length };
}

export async function upsertBarcodes(
  rows: BarcodeImportRow[],
  onProgress?: ProgressFn,
): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => r.barcode);

  await writeInBatches(
    unique,
    async (tx, part) => {
      await tx
        .insert(barcodes)
        .values(part.map((r) => ({ barcode: r.barcode, sku: r.sku, uom: r.uom })))
        .onConflictDoUpdate({
          target: barcodes.barcode,
          set: { sku: sql`excluded.sku`, uom: sql`excluded.uom` },
        });
    },
    onProgress,
  );

  return { written: unique.length };
}

export async function upsertUomConversions(
  rows: UomImportRow[],
  onProgress?: ProgressFn,
): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => `${r.sku}|${r.uom}`);

  await writeInBatches(
    unique,
    async (tx, part) => {
      await tx
        .insert(uomConversions)
        .values(part.map((r) => ({ sku: r.sku, uom: r.uom, factorToBase: String(r.factorToBase) })))
        .onConflictDoUpdate({
          target: [uomConversions.sku, uomConversions.uom],
          set: { factorToBase: sql`excluded.factor_to_base` },
        });
    },
    onProgress,
  );

  return { written: unique.length };
}

/**
 * ไฟล์ราคาอ้าง price list ด้วย "ชื่อ" — ต้อง resolve เป็น id ก่อน
 * ชื่อที่ไม่มีในระบบถือเป็น error ระดับแถว ไม่ใช่สร้าง list ใหม่ให้เงียบ ๆ
 */
export async function upsertPrices(
  rows: PriceImportRow[],
  onProgress?: ProgressFn,
): Promise<UpsertResult & { unknownPriceLists: string[] }> {
  if (rows.length === 0) return { written: 0, unknownPriceLists: [] };

  const wanted = [...new Set(rows.map((r) => r.priceListName))];
  const found = await db
    .select({ id: priceLists.id, name: priceLists.name })
    .from(priceLists)
    .where(inArray(priceLists.name, wanted));

  const idByName = new Map(found.map((l) => [l.name, l.id]));
  const unknownPriceLists = wanted.filter((n) => !idByName.has(n));

  const resolvable = rows.filter((r) => idByName.has(r.priceListName));
  const unique = dedupe(
    resolvable,
    (r) => `${r.priceListName}|${r.sku}|${r.uom}|${(r.effectiveFrom ?? new Date()).toISOString().slice(0, 10)}`,
  );

  await writeInBatches(
    unique,
    async (tx, part) => {
      await tx
        .insert(prices)
        .values(
          part.map((r) => ({
            priceListId: idByName.get(r.priceListName)!,
            sku: r.sku,
            uom: r.uom,
            unitPrice: String(r.unitPrice),
            effectiveFrom: (r.effectiveFrom ?? new Date()).toISOString().slice(0, 10),
            effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
          })),
        )
        .onConflictDoUpdate({
          target: [prices.priceListId, prices.sku, prices.uom, prices.effectiveFrom],
          set: { unitPrice: sql`excluded.unit_price`, effectiveTo: sql`excluded.effective_to` },
        });
    },
    onProgress,
  );

  return { written: unique.length, unknownPriceLists };
}

/** ยอดตั้งต้นผูกกับรอบนับ จึงต้องรู้ว่าเป็นรอบไหน ต่างจาก master ตัวอื่น */
export async function upsertExpectedStock(
  sessionId: string,
  rows: ExpectedImportRow[],
  onProgress?: ProgressFn,
): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => `${r.sku}|${r.uom}`);

  await writeInBatches(
    unique,
    async (tx, part) => {
      await tx
        .insert(expectedStock)
        .values(
          part.map((r) => ({
            sessionId,
            sku: r.sku,
            uom: r.uom,
            expectedQty: String(r.expectedQty),
          })),
        )
        .onConflictDoUpdate({
          target: [expectedStock.sessionId, expectedStock.sku, expectedStock.uom],
          set: { expectedQty: sql`excluded.expected_qty` },
        });
    },
    onProgress,
  );

  return { written: unique.length };
}

/** ลบยอดตั้งต้นเดิมของรอบก่อน import ทับ — ใช้เมื่อแอดมินเลือก "แทนที่ทั้งหมด" */
export async function clearExpectedStock(sessionId: string): Promise<void> {
  await db.delete(expectedStock).where(eq(expectedStock.sessionId, sessionId));
}

/** ปิดใช้งาน SKU ที่ไม่อยู่ในไฟล์รอบนี้ — ใช้เมื่อไฟล์ที่อัปโหลดคือ master ฉบับเต็ม */
export async function deactivateMissingProducts(keepSkus: string[]): Promise<number> {
  if (keepSkus.length === 0) return 0;

  const result = await db
    .update(products)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(products.active, true), sql`${products.sku} <> ALL(${keepSkus})`))
    .returning({ sku: products.sku });

  return result.length;
}
