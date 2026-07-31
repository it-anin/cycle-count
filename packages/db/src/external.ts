/**
 * ตารางของ "ระบบสต็อกเดิม" ที่อยู่ใน schema `public` ของ Supabase ตัวเดียวกัน
 *
 * ประกาศไว้ **เพื่ออ่านอย่างเดียว** ให้ TypeScript ช่วยจับตอนโครงตารางเปลี่ยน
 * ระบบนับสต็อกไม่เขียนอะไรลงตารางพวกนี้เด็ดขาด
 *
 * ⚠ ไฟล์นี้ต้องไม่ถูก import เข้า `schema.ts`
 * `drizzle.config.ts` ชี้ที่ `schema.ts` และตั้ง schemaFilter เป็น cycle_count เท่านั้น
 * ถ้าเผลอเอาไปรวม drizzle-kit จะ generate migration ที่ไปแก้/ลบตารางของระบบเดิม
 *
 * หมายเหตุเรื่องชนิดข้อมูล: ระบบเดิมเก็บตัวเลขเป็น `text` แทบทั้งหมด
 * (qty = "369.0000", price = "72.0000") ต้องแปลงเองทุกครั้งและกันค่าเพี้ยนด้วย
 */
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/*
 * ใช้ pgTable() ตรง ๆ ไม่ใช่ pgSchema('public')
 * Drizzle โยน error ตอน runtime ว่า "You can't specify 'public' as schema name"
 * เพราะ public เป็น schema เริ่มต้นอยู่แล้ว — TypeScript จับให้ไม่ได้ เจอตอนยิง API จริง
 *
 * ปลอดภัยเพราะไฟล์นี้ไม่ได้ถูก import เข้า schema.ts และ drizzle.config.ts ชี้ที่ schema.ts
 * drizzle-kit จึงมองไม่เห็นตารางพวกนี้ ไม่มีทาง generate migration มาแตะ
 */

/**
 * ยอดคงเหลือรายสาขา — สคริปต์ของทีมอัปเดตทุก 5 นาที
 *
 * ระบบนับสต็อกใช้เป็น "ยอดตั้งต้น" แต่ต้องถ่ายเป็น snapshot ก่อนเสมอ ห้ามอ่านสด
 * (ดู cycle_count.count_sessions.snapshot_at)
 */
export const extStock = pgTable('stock', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  /** สาขา/คลัง เช่น 'คลังสินค้า' — NOT NULL และมีหลายค่า ต้องกรองเสมอ */
  branch: text('branch').notNull(),
  sku: text('sku').notNull(),
  name: text('name'),
  /** เก็บเป็น text เช่น "369.0000" — ต้อง cast แบบกันค่าเพี้ยน */
  qty: text('qty'),
  /** หน่วยที่ยอดนี้นับเป็น เช่น กล่อง / แผง / ซอง / ขวด */
  unit: text('unit'),
  price: text('price'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
});

/** หนึ่งแถว = หนึ่งบาร์โค้ด ตรงกับโครง cycle_count.barcodes พอดี */
export const extProducts = pgTable('products', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  barcode: text('barcode'),
  sku: text('sku'),
  name: text('name'),
  unit: text('unit'),
  category: text('category'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

/** ข้อมูลสินค้าละเอียดกว่า — ใช้ดึงหน่วยฐานกับตัวคูณมาทำ uom_conversions */
export const extProductMaster = pgTable('product_master', {
  id: uuid('id').primaryKey(),
  sku: text('sku').notNull(),
  name: text('name'),
  baseUnit: text('base_unit'),
  purchaseUnit: text('purchase_unit'),
  barcodeUnit: text('barcode_unit'),
  /** จำนวนหน่วยฐานต่อหนึ่งหน่วยซื้อ — เก็บเป็น text */
  multiply: text('multiply'),
  supplier: text('supplier'),
  cost: text('cost'),
});

/**
 * แถว sentinel ที่สคริปต์ sync ใช้เช็คว่าเขียนได้ — ต้องกรองออกทุกครั้ง
 * ไม่งั้นจะกลายเป็น SKU ปลอมโผล่ในรอบนับ
 */
export const PROBE_SKU = '__probe__';
