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
import { withMasterCatalogWrite, withSessionCatalogWrite } from '@/server/catalog/version';

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

export async function upsertProducts(rows: ProductImportRow[]): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => r.sku);

  return withMasterCatalogWrite(async (tx) => {
    for (const part of chunk(unique)) {
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
    }

    return { written: unique.length };
  });
}

export async function upsertBarcodes(rows: BarcodeImportRow[]): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => r.barcode);

  return withMasterCatalogWrite(async (tx) => {
    for (const part of chunk(unique)) {
      await tx
        .insert(barcodes)
        .values(part.map((r) => ({ barcode: r.barcode, sku: r.sku, uom: r.uom })))
        .onConflictDoUpdate({
          target: barcodes.barcode,
          set: { sku: sql`excluded.sku`, uom: sql`excluded.uom` },
        });
    }

    return { written: unique.length };
  });
}

export async function upsertUomConversions(rows: UomImportRow[]): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => `${r.sku}|${r.uom}`);

  return withMasterCatalogWrite(async (tx) => {
    for (const part of chunk(unique)) {
      await tx
        .insert(uomConversions)
        .values(part.map((r) => ({ sku: r.sku, uom: r.uom, factorToBase: String(r.factorToBase) })))
        .onConflictDoUpdate({
          target: [uomConversions.sku, uomConversions.uom],
          set: { factorToBase: sql`excluded.factor_to_base` },
        });
    }

    return { written: unique.length };
  });
}

/**
 * ไฟล์ราคาอ้าง price list ด้วย "ชื่อ" — ต้อง resolve เป็น id ก่อน
 * ชื่อที่ไม่มีในระบบถือเป็น error ระดับแถว ไม่ใช่สร้าง list ใหม่ให้เงียบ ๆ
 */
export async function upsertPrices(
  rows: PriceImportRow[],
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
    (r) =>
      `${r.priceListName}|${r.sku}|${r.uom}|${(r.effectiveFrom ?? new Date()).toISOString().slice(0, 10)}`,
  );

  for (const part of chunk(unique)) {
    await db
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
  }

  return { written: unique.length, unknownPriceLists };
}

/** ยอดตั้งต้นผูกกับรอบนับ จึงต้องรู้ว่าเป็นรอบไหน ต่างจาก master ตัวอื่น */
export async function upsertExpectedStock(
  sessionId: string,
  rows: ExpectedImportRow[],
): Promise<UpsertResult> {
  const unique = dedupe(rows, (r) => `${r.sku}|${r.uom}`);

  return withSessionCatalogWrite(sessionId, async (tx) => {
    for (const part of chunk(unique)) {
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
    }

    return { written: unique.length };
  });
}

/** ลบยอดตั้งต้นเดิมของรอบก่อน import ทับ — ใช้เมื่อแอดมินเลือก "แทนที่ทั้งหมด" */
export async function clearExpectedStock(sessionId: string): Promise<void> {
  await withSessionCatalogWrite(sessionId, async (tx) => {
    await tx.delete(expectedStock).where(eq(expectedStock.sessionId, sessionId));
  });
}

/** ปิดใช้งาน SKU ที่ไม่อยู่ในไฟล์รอบนี้ — ใช้เมื่อไฟล์ที่อัปโหลดคือ master ฉบับเต็ม */
export async function deactivateMissingProducts(keepSkus: string[]): Promise<number> {
  if (keepSkus.length === 0) return 0;

  return withMasterCatalogWrite(async (tx) => {
    const result = await tx
      .update(products)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(products.active, true), sql`${products.sku} <> ALL(${keepSkus})`))
      .returning({ sku: products.sku });

    return result.length;
  });
}
