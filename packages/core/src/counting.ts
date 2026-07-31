/**
 * Counting ledger — ตรรกะของหน้าจอนับสต็อกแบบ "สมุดบัญชี"
 *
 * **หนึ่งแถว = หนึ่ง SKU** ไม่ใช่หนึ่งหน่วย
 *
 * เหตุผล: บาร์โค้ดแต่ละตัวมีตัวคูณของตัวเอง (แผง = 1, กล่อง = 12) และผลต่างเทียบกัน
 * ที่หน่วยฐานเสมอ ถ้าแยกแถวตามหน่วย SKU เดียวที่ยิงทั้งกล่องและแผงจะมีสองแถว
 * แล้วผลต่างของ SKU นั้นจะไม่รู้ว่าควรไปโชว์ที่แถวไหน — โชว์ทั้งสองก็ผิด
 * เพราะคนนับจะเข้าใจว่าแต่ละแถวขาด/เกินเท่านั้นจริง ๆ
 *
 * ภายในแถวเก็บ breakdown ว่ายิงหน่วยไหนไปกี่ครั้ง จำนวนที่คนนับเห็นจึงยังเป็น
 * หน่วยที่ตัวเองหยิบจริง (3 กล่อง) พร้อมกำกับหน่วยฐานให้ (= 36 ชิ้น)
 *
 * ฟังก์ชันทั้งหมดบริสุทธิ์ (pure) และไม่แปลง array เดิม — คืน array ใหม่เสมอ
 */

/**
 * โหมดของรอบนับ — ต้องตรงกับ pgEnum `count_mode` ใน @cycle-count/db
 *
 *  - blind   = ปิดยอดระบบ `expectedBaseQty` เป็น null ทุกรายการ
 *              เพราะ server ไม่ส่งตัวเลขลงมาเลย ไม่ใช่แค่ซ่อนในหน้าจอ
 *  - recount = รอบทวน เปิดยอดระบบให้เห็นและเทียบผลต่างได้
 */
export type CountMode = 'blind' | 'recount';

/** ผลการค้นบาร์โค้ดจาก master data */
export interface BarcodeLookup {
  barcode: string;
  sku: string;
  name: string;
  /** หน่วยที่บาร์โค้ดนี้แทน เช่น 'กล่อง' */
  uom: string;
  /** จำนวนหน่วยฐานใน 1 หน่วยนี้ — ยิงบาร์โค้ดกล่องหนึ่งครั้ง = factorToBase ชิ้น */
  factorToBase: number;
  /** ชื่อหน่วยฐานของสินค้า เช่น 'ชิ้น' — ใช้กำกับให้คนนับเห็นว่าแปลงเป็นเท่าไหร่ */
  baseUom: string;
  /**
   * ยอดตั้งต้นของ **ทั้ง SKU** ในหน่วยฐาน — null = รอบนี้ไม่มี snapshot ให้เทียบ
   * (รอบ blind เป็น null เสมอเพราะ server ไม่ส่งลงมา)
   */
  expectedBaseQty: number | null;
  location: string | null;
}

/** จำนวนที่นับได้ของหน่วยหนึ่งภายในแถว */
export interface LedgerUnit {
  uom: string;
  factorToBase: number;
  qty: number;
  /** บาร์โค้ดที่ยิงล่าสุดของหน่วยนี้ */
  lastBarcode: string;
  scanCount: number;
}

/** หนึ่งบรรทัดในสมุดบัญชี = หนึ่ง SKU */
export interface LedgerRow {
  /** `sku` หรือ `?|barcode` ถ้ายิงแล้วไม่พบใน master */
  key: string;
  sku: string | null;
  name: string;
  baseUom: string;
  /** หน่วยที่ยิงไปแล้ว เรียงหน่วยที่ยิงล่าสุดไว้หน้าสุด */
  units: LedgerUnit[];
  expectedBaseQty: number | null;
  location: string | null;
  updatedAt: string;
  /** true = ต้องให้แอดมิน review (ไม่พบ SKU) */
  flagged: boolean;
}

export type VarianceKind = 'match' | 'short' | 'over' | 'unknown';

export interface LedgerTotals {
  /** จำนวนแถว = จำนวน SKU */
  skuCount: number;
  /** จำนวนหน่วยย่อยทั้งหมด — หนึ่ง SKU ที่ยิงสองหน่วยนับเป็น 2 */
  lineCount: number;
  /** ผลรวมที่แปลงเป็นหน่วยฐานแล้ว */
  totalBaseQty: number;
  matched: number;
  short: number;
  over: number;
  /** แถวที่ไม่พบ SKU */
  unknown: number;
  /** พบ SKU แต่รอบนี้ไม่มียอดตั้งต้น จึงยังตัดสินผลต่างไม่ได้ */
  withoutExpected: number;
}

/**
 * คีย์ประจำแถว
 * - พบ SKU → `sku` (ทุกบาร์โค้ดทุกหน่วยของ SKU นี้รวมอยู่แถวเดียวกัน)
 * - ไม่พบ → `?|barcode` (แยกตามบาร์โค้ดที่ยิงได้จริง เพราะยังไม่รู้ว่าคืออะไร)
 */
export function ledgerKey(sku: string | null, barcode: string): string {
  return sku ? sku : `?|${barcode}`;
}

/** จำนวนที่นับได้ของทั้งแถว แปลงเป็นหน่วยฐานแล้ว */
export function countedBaseQty(row: LedgerRow): number {
  return row.units.reduce((sum, u) => sum + u.qty * u.factorToBase, 0);
}

/** ผลต่างในหน่วยฐาน — null เมื่อรอบนี้ไม่มียอดตั้งต้นให้เทียบ */
export function variance(row: LedgerRow): number | null {
  if (row.expectedBaseQty === null) return null;
  return countedBaseQty(row) - row.expectedBaseQty;
}

export function varianceKind(row: LedgerRow): VarianceKind {
  if (row.flagged || row.expectedBaseQty === null) return 'unknown';
  const v = countedBaseQty(row) - row.expectedBaseQty;
  if (v === 0) return 'match';
  return v < 0 ? 'short' : 'over';
}

/** ดันสมาชิกที่ตรงเงื่อนไขขึ้นหน้าสุด (ลำดับของตัวอื่นคงไว้) */
function hoist<T>(items: T[], match: (item: T) => boolean): T[] {
  const idx = items.findIndex(match);
  if (idx <= 0) return items;
  const next = items.slice();
  const [found] = next.splice(idx, 1);
  next.unshift(found!);
  return next;
}

function stamp(iso?: string): string {
  return iso ?? new Date().toISOString();
}

/** บวกจำนวนเข้าไปในหน่วยที่ระบุ แล้วดันหน่วยนั้นขึ้นหน้าสุดของแถว */
function addToUnit(
  units: LedgerUnit[],
  uom: string,
  factorToBase: number,
  addQty: number,
  barcode: string,
): LedgerUnit[] {
  const existing = units.find((u) => u.uom === uom);

  if (existing) {
    const updated = units.map((u) =>
      u.uom === uom
        ? {
            ...u,
            qty: u.qty + addQty,
            // ตัวคูณอาจถูกแก้ใน master ระหว่างรอบ — ใช้ค่าล่าสุดที่ server ส่งมา
            factorToBase,
            lastBarcode: barcode,
            scanCount: u.scanCount + 1,
          }
        : u,
    );
    return hoist(updated, (u) => u.uom === uom);
  }

  return [{ uom, factorToBase, qty: addQty, lastBarcode: barcode, scanCount: 1 }, ...units];
}

/**
 * ยิงบาร์โค้ดที่พบใน master data
 * แถวเดิม → บวกเข้าไปในหน่วยของบาร์โค้ดนั้น แล้วดันแถวขึ้นบนสุด
 */
export function applyScan(
  rows: LedgerRow[],
  lookup: BarcodeLookup,
  addQty = 1,
  at?: string,
): LedgerRow[] {
  const key = ledgerKey(lookup.sku, lookup.barcode);
  const existing = rows.find((r) => r.key === key);

  if (existing) {
    const updated: LedgerRow = {
      ...existing,
      name: lookup.name,
      baseUom: lookup.baseUom,
      units: addToUnit(existing.units, lookup.uom, lookup.factorToBase, addQty, lookup.barcode),
      // ยอดตั้งต้นอาจเพิ่งถูก snapshot หลังยิงครั้งแรก จึงรับค่าใหม่ถ้ามี
      expectedBaseQty: lookup.expectedBaseQty ?? existing.expectedBaseQty,
      updatedAt: stamp(at),
    };
    return hoist(
      rows.map((r) => (r.key === key ? updated : r)),
      (r) => r.key === key,
    );
  }

  const created: LedgerRow = {
    key,
    sku: lookup.sku,
    name: lookup.name,
    baseUom: lookup.baseUom,
    units: [
      {
        uom: lookup.uom,
        factorToBase: lookup.factorToBase,
        qty: addQty,
        lastBarcode: lookup.barcode,
        scanCount: 1,
      },
    ],
    expectedBaseQty: lookup.expectedBaseQty,
    location: lookup.location,
    updatedAt: stamp(at),
    flagged: false,
  };
  return [created, ...rows];
}

/**
 * ยิงบาร์โค้ดที่ไม่พบใน master data
 * ยังบันทึกไว้ (flagged) เพราะของมีอยู่จริงบนชั้น — ให้แอดมินตามทีหลัง
 */
export function applyUnknownScan(
  rows: LedgerRow[],
  barcode: string,
  addQty = 1,
  at?: string,
): LedgerRow[] {
  const key = ledgerKey(null, barcode);
  const existing = rows.find((r) => r.key === key);

  if (existing) {
    const updated: LedgerRow = {
      ...existing,
      units: addToUnit(existing.units, existing.baseUom, 1, addQty, barcode),
      updatedAt: stamp(at),
    };
    return hoist(
      rows.map((r) => (r.key === key ? updated : r)),
      (r) => r.key === key,
    );
  }

  const created: LedgerRow = {
    key,
    sku: null,
    name: 'ไม่พบในระบบ',
    baseUom: 'ชิ้น',
    units: [{ uom: 'ชิ้น', factorToBase: 1, qty: addQty, lastBarcode: barcode, scanCount: 1 }],
    expectedBaseQty: null,
    location: null,
    updatedAt: stamp(at),
    flagged: true,
  };
  return [created, ...rows];
}

/** ตั้งจำนวนของหน่วยหนึ่งตรง ๆ (จากการแก้ในแถว) — ติดลบไม่ได้ */
export function setUnitQty(
  rows: LedgerRow[],
  key: string,
  uom: string,
  qty: number,
  at?: string,
): LedgerRow[] {
  const safe = Number.isFinite(qty) ? Math.max(0, qty) : 0;
  return rows.map((r) =>
    r.key === key
      ? {
          ...r,
          units: r.units.map((u) => (u.uom === uom ? { ...u, qty: safe } : u)),
          updatedAt: stamp(at),
        }
      : r,
  );
}

/** บวก/ลบทีละหน่วยจากปุ่ม − + */
export function bumpUnitQty(
  rows: LedgerRow[],
  key: string,
  uom: string,
  delta: number,
  at?: string,
): LedgerRow[] {
  const unit = rows.find((r) => r.key === key)?.units.find((u) => u.uom === uom);
  if (!unit) return rows;
  return setUnitQty(rows, key, uom, unit.qty + delta, at);
}

/** ลบหน่วยหนึ่งออกจากแถว — ถ้าไม่เหลือหน่วยเลย ลบทั้งแถว */
export function removeUnit(rows: LedgerRow[], key: string, uom: string, at?: string): LedgerRow[] {
  return rows
    .map((r) =>
      r.key === key
        ? { ...r, units: r.units.filter((u) => u.uom !== uom), updatedAt: stamp(at) }
        : r,
    )
    .filter((r) => r.units.length > 0);
}

export function removeRow(rows: LedgerRow[], key: string): LedgerRow[] {
  return rows.filter((r) => r.key !== key);
}

export function ledgerTotals(rows: LedgerRow[]): LedgerTotals {
  let lineCount = 0;
  let totalBaseQty = 0;
  let matched = 0;
  let short = 0;
  let over = 0;
  let unknown = 0;
  let withoutExpected = 0;

  for (const row of rows) {
    lineCount += row.units.length;
    totalBaseQty += countedBaseQty(row);

    switch (varianceKind(row)) {
      case 'match':
        matched += 1;
        break;
      case 'short':
        short += 1;
        break;
      case 'over':
        over += 1;
        break;
      default:
        if (row.flagged) unknown += 1;
        else withoutExpected += 1;
    }
  }

  return {
    skuCount: rows.length,
    lineCount,
    totalBaseQty,
    matched,
    short,
    over,
    unknown,
    withoutExpected,
  };
}

/**
 * payload หนึ่งบรรทัดที่จะส่งขึ้น count_lines
 *
 * ส่งแยกตามหน่วยที่ยิงจริง ไม่ยุบเป็นหน่วยฐาน — เก็บหลักฐานไว้ว่าคนนับหยิบอะไรมา
 * ฝั่งรายงานค่อยคูณ factorToBase รวมเองตอนเทียบผลต่าง
 */
export interface CountLinePayload {
  /** คีย์ที่ server ใช้ upsert — `sku|uom` หรือ `?|barcode` ส่งซ้ำกี่ครั้งก็ได้แถวเดียว */
  lineKey: string;
  sku: string | null;
  uom: string;
  factorToBase: number;
  scannedBarcode: string;
  countedQty: number;
  flagged: boolean;
  countedAt: string;
}

export function toCountLines(rows: LedgerRow[]): CountLinePayload[] {
  return rows.flatMap((row) =>
    row.units.map((unit) => ({
      lineKey: row.sku ? `${row.sku}|${unit.uom}` : row.key,
      sku: row.sku,
      uom: unit.uom,
      factorToBase: unit.factorToBase,
      scannedBarcode: unit.lastBarcode,
      countedQty: unit.qty,
      flagged: row.flagged,
      countedAt: row.updatedAt,
    })),
  );
}
