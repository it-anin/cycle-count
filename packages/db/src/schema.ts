import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * ทุกตารางของระบบนับสต็อกอยู่ใน Postgres schema ของตัวเอง ไม่ใช่ `public`
 *
 * โปรเจกต์ Supabase นี้ใช้ร่วมกับระบบอื่นที่มีข้อมูล production อยู่แล้ว
 * ถ้าวางไว้ใน public จะเสี่ยงสองเรื่อง:
 *   1. ชื่อตารางชนกัน — `products`, `prices`, และโดยเฉพาะ `profiles`
 *      ซึ่งเป็นชื่อ convention มาตรฐานของ Supabase
 *   2. migration RLS จะไป ENABLE ROW LEVEL SECURITY ทับตารางของระบบอื่น
 *      ซึ่งไม่มี policy รองรับ = ปฏิเสธทุก query = ระบบเขาล่ม
 *
 * ผลพลอยได้: schema นี้ไม่ได้ถูก expose ให้ PostgREST ของ Supabase
 * (ค่าเริ่มต้นเปิดแค่ public) ตารางเราจึงยิงผ่าน REST API ตรง ๆ ไม่ได้เลย
 * ปลอดภัยกว่า RLS อีกชั้น
 */
export const cc = pgSchema('cycle_count');

const pgTable = cc.table.bind(cc);
const pgEnum = cc.enum.bind(cc);

/* -------------------------------------------------------------------------- */
/*                                   Enums                                     */
/* -------------------------------------------------------------------------- */

export const userRole = pgEnum('user_role', ['admin', 'counter']);
export const sessionStatus = pgEnum('session_status', ['draft', 'active', 'closed']);

/**
 * โหมดของรอบนับ
 *  - blind   = ปิดยอดระบบ ไม่ส่ง expectedQty ลงเครื่อง PDA เลย (ข้อบังคับของผู้ตรวจสอบบัญชีสำหรับรอบแรก)
 *  - recount = รอบทวน เปิดยอดระบบให้เห็น เพราะจุดประสงค์คือไปยืนยันตัวที่มีผลต่าง
 *
 * ค่าที่บันทึกไว้เป็นหลักฐานให้ผู้ตรวจสอบว่ารอบแรกปิดยอดจริง
 */
export const countMode = pgEnum('count_mode', ['blind', 'recount']);
export const importType = pgEnum('import_type', [
  'products',
  'barcodes',
  'uom',
  'prices',
  'expected',
]);
export const importStatus = pgEnum('import_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

/* -------------------------------------------------------------------------- */
/*                       Master data (มาจากไฟล์ Excel)                         */
/* -------------------------------------------------------------------------- */

/** SKU master — ไฟล์หลัก */
export const products = pgTable('products', {
  sku: text('sku').primaryKey(),
  name: text('name').notNull(),
  /** หน่วยฐานสำหรับคำนวณ (เช่น 'PCS') */
  baseUom: text('base_uom').notNull().default('PCS'),
  category: text('category'),
  /** ตำแหน่งชั้นวาง เช่น 'A-12-03' — PDA แสดงให้คนนับเดินหาถูกที่ */
  location: text('location'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** บาร์โค้ด → SKU + หน่วยที่บาร์โค้ดนั้นแทน (ลัง ≠ ชิ้น จึงคนละบาร์โค้ด) */
export const barcodes = pgTable(
  'barcodes',
  {
    barcode: text('barcode').primaryKey(),
    sku: text('sku')
      .notNull()
      .references(() => products.sku, { onDelete: 'cascade' }),
    uom: text('uom').notNull(),
  },
  (t) => [index('barcodes_sku_idx').on(t.sku)],
);

/**
 * บาร์โค้ด → หน่วย + ตัวคูณ จากรายงาน R05106 ของระบบ POS
 *
 * นี่คือ **แหล่งข้อมูลหลักของตัวคูณ** ไม่ใช่ product_master.multiply
 * เพราะ product_master เก็บตัวคูณได้ค่าเดียวต่อ SKU แต่ของจริง SKU หนึ่งมีได้หลายบาร์โค้ด
 * ที่ตัวคูณต่างกัน เช่น 100098 = แผง(1) / 10แผง(10) / โหล(12) / กล่อง(50)
 *
 * ตรวจกับไฟล์จริง 10,841 แถวแล้ว: บาร์โค้ดไม่ซ้ำเลย ตัวคูณเป็นตัวเลขทุกแถว
 * และทุก SKU มีหน่วยที่ตัวคูณ = 1 (หน่วยฐาน) เสมอ
 *
 * ไม่ผูก FK ไป products เพราะตารางนี้เป็นตัว **สร้าง** products ขึ้นมา
 */
export const barcodeUnits = pgTable(
  'barcode_units',
  {
    barcode: text('barcode').primaryKey(),
    sku: text('sku').notNull(),
    name: text('name'),
    uom: text('uom').notNull(),
    /** จำนวนหน่วยฐานใน 1 หน่วยนี้ — ตัวคูณ 1 = หน่วยฐานของ SKU นั้น */
    factorToBase: numeric('factor_to_base', { precision: 14, scale: 4 }).notNull(),
    price: numeric('price', { precision: 14, scale: 4 }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('barcode_units_sku_idx').on(t.sku)],
);

/** การแปลงหน่วย: 1 <uom> = factorToBase <baseUom> (เช่น 1 CASE = 12 PCS) */
export const uomConversions = pgTable(
  'uom_conversions',
  {
    sku: text('sku')
      .notNull()
      .references(() => products.sku, { onDelete: 'cascade' }),
    uom: text('uom').notNull(),
    factorToBase: numeric('factor_to_base', { precision: 14, scale: 4 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sku, t.uom] })],
);

/* -------------------------------------------------------------------------- */
/*                           Pricing (หลาย price list)                         */
/* -------------------------------------------------------------------------- */

/** นิยาม price list (ตามลูกค้า/ช่องทาง) — มีอันหนึ่งเป็น default สำหรับ fallback */
export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    customerGroup: text('customer_group'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('price_lists_name_idx').on(t.name)],
);

/** ราคาต่อหน่วย ณ ช่วงเวลา — ราคาอาจกำหนดเฉพาะบางหน่วย (ที่เหลือคำนวณจาก factor) */
export const prices = pgTable(
  'prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    sku: text('sku')
      .notNull()
      .references(() => products.sku, { onDelete: 'cascade' }),
    uom: text('uom').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    effectiveFrom: date('effective_from').notNull().defaultNow(),
    effectiveTo: date('effective_to'),
  },
  (t) => [
    index('prices_lookup_idx').on(t.priceListId, t.sku, t.uom),
    uniqueIndex('prices_unique_idx').on(t.priceListId, t.sku, t.uom, t.effectiveFrom),
  ],
);

/* -------------------------------------------------------------------------- */
/*                              Users / profiles                              */
/* -------------------------------------------------------------------------- */

/**
 * ข้อมูลผู้ใช้เสริมของ Supabase Auth (auth.users).
 * ไม่ผูก FK ข้าม schema ที่นี่ — จะเพิ่มใน migration แยกถ้าต้องการ
 */
export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id').primaryKey(),
    name: text('name').notNull(),
    /**
     * รหัสพนักงาน เช่น 'EMP-2041' — PDA ล็อกอินด้วยรหัสนี้ + PIN
     * ฝั่ง server map เป็นอีเมลสังเคราะห์ก่อนเรียก Supabase Auth
     */
    employeeCode: text('employee_code').notNull(),
    /** คลังที่สังกัด แสดงบนแถบบนของ PDA */
    warehouse: text('warehouse'),
    role: userRole('role').notNull().default('counter'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('profiles_employee_code_idx').on(t.employeeCode)],
);

/* -------------------------------------------------------------------------- */
/*                            Counting (รอบนับ)                                */
/* -------------------------------------------------------------------------- */

/** รอบนับหนึ่งครั้ง (ผูก price list ไว้ใช้ตีมูลค่า variance) */
export const countSessions = pgTable(
  'count_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** รหัสสั้นที่คนเรียกกันหน้างาน เช่น 'CC-2607-A' — แถบบนของ PDA แสดงค่านี้ */
    code: text('code').notNull(),
    name: text('name').notNull(),
    location: text('location'),
    /** default เป็น blind เพื่อให้พลาดไปทางที่ปลอดภัย — แอดมินต้องตั้งใจเลือกเปิดยอด */
    mode: countMode('mode').notNull().default('blind'),
    status: sessionStatus('status').notNull().default('draft'),
    priceListId: uuid('price_list_id').references(() => priceLists.id, { onDelete: 'set null' }),
    /**
     * เวลาที่ถ่าย snapshot ยอดตั้งต้น = **cut-off ของรอบนับ**
     *
     * ระบบต้นทางอัปเดตทุก 5 นาที ยอดจึงวิ่งตลอด เราแช่แข็งไว้ ณ วินาทีที่เปิดรอบ
     * แล้วเทียบผลต่างกับค่านั้น ไม่ใช่ค่าสด — ไม่งั้นของที่ถูกเบิกไประหว่างนับ
     * จะกลายเป็น "ของหาย" และรายงานเดิมจะให้เลขไม่เท่ากันทุกครั้งที่เปิดดู
     *
     * ค่านี้คือสิ่งที่ผู้ตรวจสอบบัญชีจะถามหาว่า "ยอดคงเหลือ ณ เวลาไหน"
     */
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    /** ยอดตั้งต้นมาจากไหน เช่น 'excel' หรือ 'public.stock' — ไว้ตามรอย */
    expectedSource: text('expected_source'),
    /**
     * ค่า `branch` ใน public.stock ที่รอบนี้ดึงยอดมา เช่น 'คลังสินค้า'
     * ต้องระบุเสมอเมื่อดึงจาก public.stock ไม่งั้นยอดจะรวมทุกสาขาเข้ามาปนกัน
     */
    sourceBranch: text('source_branch'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('count_sessions_code_idx').on(t.code)],
);

/** ยอดตั้งต้น (snapshot) ที่คาดว่าจะมี ต่อ SKU+หน่วย ในรอบนับ */
export const expectedStock = pgTable(
  'expected_stock',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => countSessions.id, { onDelete: 'cascade' }),
    sku: text('sku')
      .notNull()
      .references(() => products.sku, { onDelete: 'cascade' }),
    uom: text('uom').notNull(),
    expectedQty: numeric('expected_qty', { precision: 14, scale: 4 }).notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.sku, t.uom] })],
);

/**
 * ผลนับจาก PDA — หนึ่งแถวต่อ (รอบนับ, รายการ, คนนับ)
 *
 * PDA ส่ง "ยอดรวมของแถว" ขึ้นมา ไม่ใช่ส่วนต่าง เพราะหน้าจอให้ผู้ใช้แก้ยอดรวมได้ตลอด
 * ฝั่ง server จึง upsert ทับ ไม่ใช่ append — ส่งซ้ำกี่ครั้งก็ได้ผลเท่าเดิม
 *
 * แยกตาม countedBy เพื่อให้พนักงานสองคนนับ SKU เดียวกันคนละโซนได้ รายงานค่อย SUM รวม
 */
export const countLines = pgTable(
  'count_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => countSessions.id, { onDelete: 'cascade' }),
    /**
     * คีย์ประจำรายการจาก ledgerKey() ใน @cycle-count/core — `sku|uom` หรือ `?|barcode`
     * ใช้แทน (sku, uom) ตรง ๆ เพราะแถวที่ไม่พบ SKU มี sku = NULL
     * และ Postgres ถือว่า NULL แต่ละตัวไม่เท่ากัน unique index จึงจะไม่กันซ้ำให้
     */
    lineKey: text('line_key').notNull(),
    sku: text('sku').references(() => products.sku, { onDelete: 'set null' }),
    uom: text('uom').notNull(),
    /**
     * ตัวคูณของหน่วยนี้ **ณ เวลาที่นับ** ไม่ใช่ค่าปัจจุบันใน uom_conversions
     *
     * ถ้า master แก้ตัวคูณทีหลัง รายงานเก่าต้องยังให้ตัวเลขเดิม จึงต้องเก็บติดไว้กับบรรทัด
     * ผลต่างคำนวณที่หน่วยฐาน = counted_qty × factor_to_base
     */
    factorToBase: numeric('factor_to_base', { precision: 14, scale: 4 }).notNull().default('1'),
    scannedBarcode: text('scanned_barcode'),
    countedQty: numeric('counted_qty', { precision: 14, scale: 4 }).notNull(),
    /** true = สแกนแล้วไม่พบ SKU (ต้อง review) */
    flagged: boolean('flagged').notNull().default(false),
    countedBy: uuid('counted_by').notNull(),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('count_lines_session_idx').on(t.sessionId),
    index('count_lines_session_sku_idx').on(t.sessionId, t.sku),
    uniqueIndex('count_lines_upsert_idx').on(t.sessionId, t.lineKey, t.countedBy),
  ],
);

/* -------------------------------------------------------------------------- */
/*                          Import audit (การอัปโหลด)                          */
/* -------------------------------------------------------------------------- */

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: importType('type').notNull(),
  /** ต้องระบุเมื่อ type = 'expected' เพราะยอดตั้งต้นผูกกับรอบนับ */
  sessionId: uuid('session_id').references(() => countSessions.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  /** path ใน Supabase Storage */
  storagePath: text('storage_path'),
  status: importStatus('status').notNull().default('pending'),
  rowCount: integer('row_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  errors: jsonb('errors').$type<ImportRowError[]>().default(sql`'[]'::jsonb`),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ImportRowError = {
  row: number;
  message: string;
  value?: unknown;
};

/* -------------------------------------------------------------------------- */
/*                                 Relations                                   */
/* -------------------------------------------------------------------------- */

export const productsRelations = relations(products, ({ many }) => ({
  barcodes: many(barcodes),
  uomConversions: many(uomConversions),
  prices: many(prices),
}));

export const barcodesRelations = relations(barcodes, ({ one }) => ({
  product: one(products, { fields: [barcodes.sku], references: [products.sku] }),
}));

export const uomConversionsRelations = relations(uomConversions, ({ one }) => ({
  product: one(products, { fields: [uomConversions.sku], references: [products.sku] }),
}));

export const priceListsRelations = relations(priceLists, ({ many }) => ({
  prices: many(prices),
  sessions: many(countSessions),
}));

export const pricesRelations = relations(prices, ({ one }) => ({
  priceList: one(priceLists, { fields: [prices.priceListId], references: [priceLists.id] }),
  product: one(products, { fields: [prices.sku], references: [products.sku] }),
}));

export const countSessionsRelations = relations(countSessions, ({ one, many }) => ({
  priceList: one(priceLists, {
    fields: [countSessions.priceListId],
    references: [priceLists.id],
  }),
  expected: many(expectedStock),
  lines: many(countLines),
}));

export const expectedStockRelations = relations(expectedStock, ({ one }) => ({
  session: one(countSessions, {
    fields: [expectedStock.sessionId],
    references: [countSessions.id],
  }),
  product: one(products, { fields: [expectedStock.sku], references: [products.sku] }),
}));

export const countLinesRelations = relations(countLines, ({ one }) => ({
  session: one(countSessions, {
    fields: [countLines.sessionId],
    references: [countSessions.id],
  }),
  product: one(products, { fields: [countLines.sku], references: [products.sku] }),
}));

/* -------------------------------------------------------------------------- */
/*                              Inferred types                                */
/* -------------------------------------------------------------------------- */

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Barcode = typeof barcodes.$inferSelect;
export type UomConversion = typeof uomConversions.$inferSelect;
export type PriceList = typeof priceLists.$inferSelect;
export type Price = typeof prices.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type CountSession = typeof countSessions.$inferSelect;
export type NewCountSession = typeof countSessions.$inferInsert;
export type ExpectedStock = typeof expectedStock.$inferSelect;
export type CountLine = typeof countLines.$inferSelect;
export type NewCountLine = typeof countLines.$inferInsert;
export type ImportBatch = typeof importBatches.$inferSelect;
