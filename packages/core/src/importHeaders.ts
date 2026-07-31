/**
 * แปลงหัวคอลัมน์ของไฟล์ Excel เป็นคีย์ที่ schema รู้จัก
 *
 * ไฟล์จริงจากฝ่ายจัดซื้อ/บัญชีมีหัวคอลัมน์เป็นภาษาไทยบ้าง อังกฤษบ้าง เว้นวรรคบ้าง
 * ถ้าบังคับให้ตรง key ของ Zod เป๊ะ ๆ คนกรอกไฟล์จะเจอ error ทุกแถวโดยไม่รู้สาเหตุ
 *
 * เทียบแบบ normalize แล้ว (พิมพ์เล็ก ตัดช่องว่าง/ขีด/จุด) — `Base UOM`, `base_uom`,
 * `หน่วยฐาน` จึงเข้าคีย์เดียวกันหมด
 */
import type { ImportKind } from './schemas';

/** คีย์ที่ schema รู้จัก → หัวคอลัมน์ที่ยอมรับ */
const ALIASES: Record<ImportKind, Record<string, string[]>> = {
  products: {
    sku: ['sku', 'รหัสสินค้า', 'itemcode', 'productcode'],
    name: ['name', 'ชื่อสินค้า', 'productname', 'itemname', 'description'],
    baseUom: ['baseuom', 'หน่วยฐาน', 'หน่วยนับ', 'unit', 'uom'],
    category: ['category', 'หมวด', 'หมวดหมู่', 'group'],
    location: ['location', 'ตำแหน่ง', 'ชั้นวาง', 'ที่เก็บ', 'bin', 'shelf'],
    active: ['active', 'สถานะ', 'ใช้งาน', 'enabled'],
  },
  barcodes: {
    barcode: ['barcode', 'บาร์โค้ด', 'ean', 'upc'],
    sku: ['sku', 'รหัสสินค้า', 'itemcode'],
    uom: ['uom', 'หน่วย', 'หน่วยนับ', 'unit'],
  },
  uom: {
    sku: ['sku', 'รหัสสินค้า', 'itemcode'],
    uom: ['uom', 'หน่วย', 'หน่วยนับ', 'unit'],
    factorToBase: ['factortobase', 'ตัวคูณ', 'จำนวนต่อหน่วย', 'factor', 'qtyperuom'],
  },
  prices: {
    priceListName: ['pricelistname', 'pricelist', 'ชื่อราคา', 'รายการราคา', 'กลุ่มราคา'],
    sku: ['sku', 'รหัสสินค้า', 'itemcode'],
    uom: ['uom', 'หน่วย', 'หน่วยนับ', 'unit'],
    unitPrice: ['unitprice', 'ราคา', 'ราคาต่อหน่วย', 'price'],
    effectiveFrom: ['effectivefrom', 'เริ่มใช้', 'วันที่เริ่ม', 'from'],
    effectiveTo: ['effectiveto', 'สิ้นสุด', 'วันที่สิ้นสุด', 'to'],
  },
  expected: {
    sku: ['sku', 'รหัสสินค้า', 'itemcode'],
    uom: ['uom', 'หน่วย', 'หน่วยนับ', 'unit'],
    expectedQty: ['expectedqty', 'ยอดระบบ', 'จำนวนคงเหลือ', 'คงเหลือ', 'onhand', 'qty'],
  },
};

/** ตัดช่องว่าง ขีด ขีดล่าง จุด แล้วพิมพ์เล็ก */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s._-]/g, '');
}

/** สร้างตารางค้น: หัวคอลัมน์ที่ normalize แล้ว → คีย์ของ schema */
function lookupTable(kind: ImportKind): Map<string, string> {
  const table = new Map<string, string>();
  for (const [key, aliases] of Object.entries(ALIASES[kind])) {
    table.set(normalizeHeader(key), key);
    for (const alias of aliases) table.set(normalizeHeader(alias), key);
  }
  return table;
}

/**
 * แปลงแถวดิบจาก sheet_to_json ให้ใช้คีย์ของ schema
 * คอลัมน์ที่ไม่รู้จักถูกตัดทิ้ง และค่าว่าง/ช่องว่างล้วนถือเป็น undefined
 * เพื่อให้ `.optional()` กับ `.default()` ของ Zod ทำงานตามที่ตั้งใจ
 */
export function normalizeRows(kind: ImportKind, rows: Record<string, unknown>[]): unknown[] {
  const table = lookupTable(kind);

  return rows.map((raw) => {
    const out: Record<string, unknown> = {};

    for (const [header, value] of Object.entries(raw)) {
      const key = table.get(normalizeHeader(header));
      if (!key) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      out[key] = value;
    }

    return out;
  });
}

/** หัวคอลัมน์ที่ต้องมีอย่างน้อย — ใช้เตือนตั้งแต่ก่อน validate ทีละแถว */
export function missingRequiredHeaders(kind: ImportKind, headers: string[]): string[] {
  const table = lookupTable(kind);
  const present = new Set(headers.map((h) => table.get(normalizeHeader(h))).filter(Boolean));

  const required: Record<ImportKind, string[]> = {
    products: ['sku', 'name'],
    barcodes: ['barcode', 'sku', 'uom'],
    uom: ['sku', 'uom', 'factorToBase'],
    prices: ['priceListName', 'sku', 'uom', 'unitPrice'],
    expected: ['sku', 'uom', 'expectedQty'],
  };

  return required[kind].filter((key) => !present.has(key));
}
