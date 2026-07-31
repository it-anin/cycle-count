/**
 * Pricing resolution — ตรรกะดึงราคา "ซับซ้อนระดับกลาง"
 *
 * ครอบคลุม:
 *  - แปลงหน่วย (ชิ้น/แพ็ค/ลัง) ผ่าน factorToBase
 *  - หลาย price list / ตามลูกค้า พร้อม fallback ไป default list
 *  - ราคามีผลตามช่วงเวลา (effectiveFrom / effectiveTo)
 *
 * ฟังก์ชันนี้ "บริสุทธิ์" (pure) — รับข้อมูลที่โหลดมาแล้ว ไม่แตะ DB โดยตรง
 * เพื่อให้ทดสอบง่ายและ reuse ได้ทั้ง web / pda / server
 */

export interface PriceRow {
  priceListId: string;
  sku: string;
  uom: string;
  unitPrice: number;
  /** ISO date 'YYYY-MM-DD' */
  effectiveFrom: string;
  /** ISO date 'YYYY-MM-DD' หรือ null = ไม่มีวันหมดอายุ */
  effectiveTo: string | null;
}

export interface UomConversionRow {
  sku: string;
  uom: string;
  /** จำนวนหน่วยฐานใน 1 หน่วยนี้ (เช่น CASE => 24) */
  factorToBase: number;
}

export interface PriceListMeta {
  id: string;
  isDefault: boolean;
}

export interface PriceLookupData {
  prices: PriceRow[];
  conversions: UomConversionRow[];
  priceLists: PriceListMeta[];
}

export interface ResolvePriceInput {
  sku: string;
  uom: string;
  priceListId: string;
  /** วันที่อ้างอิง (default = วันนี้) */
  date?: Date;
}

export type PriceSource = 'exact' | 'converted';

export interface ResolvePriceResult {
  unitPrice: number;
  /** ราคาถูกกำหนดตรงหน่วยที่ขอ หรือคำนวณจากการแปลงหน่วย */
  source: PriceSource;
  /** price list ที่ราคามาจริง (อาจต่างจากที่ขอ ถ้า fallback) */
  priceListId: string;
  /** true ถ้าได้จาก fallback (default list) ไม่ใช่ list ที่ขอ */
  fromFallback: boolean;
  /** หน่วยต้นทางที่ราคาถูกกำหนด (ก่อนแปลง) */
  basedOnUom: string;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isEffective(row: PriceRow, dateStr: string): boolean {
  if (row.effectiveFrom > dateStr) return false;
  if (row.effectiveTo && row.effectiveTo < dateStr) return false;
  return true;
}

/** เลือก effectiveFrom ล่าสุดที่ยังไม่เกินวันที่ (ราคาใหม่ทับราคาเก่า) */
function pickLatest(rows: PriceRow[]): PriceRow | undefined {
  return rows.reduce<PriceRow | undefined>((best, r) => {
    if (!best) return r;
    return r.effectiveFrom > best.effectiveFrom ? r : best;
  }, undefined);
}

function resolveInList(
  data: PriceLookupData,
  sku: string,
  targetUom: string,
  priceListId: string,
  dateStr: string,
): Omit<ResolvePriceResult, 'fromFallback'> | null {
  const effective = data.prices.filter(
    (p) => p.priceListId === priceListId && p.sku === sku && isEffective(p, dateStr),
  );
  if (effective.length === 0) return null;

  // 1) ตรงหน่วยพอดี
  const exact = pickLatest(effective.filter((p) => p.uom === targetUom));
  if (exact) {
    return { unitPrice: exact.unitPrice, source: 'exact', priceListId, basedOnUom: targetUom };
  }

  // 2) แปลงหน่วย: price(target) = price(source) * factor(target) / factor(source)
  const factors = new Map(
    data.conversions.filter((c) => c.sku === sku).map((c) => [c.uom, c.factorToBase]),
  );
  const factorTarget = factors.get(targetUom);
  if (factorTarget === undefined || factorTarget <= 0) return null;

  // เลือกราคาต้นทางที่แปลงได้ โดยชอบหน่วยฐาน (factor=1) ก่อนเพื่อความเสถียร
  const convertible = effective
    .filter((p) => {
      const f = factors.get(p.uom);
      return f !== undefined && f > 0;
    })
    .sort((a, b) => (factors.get(a.uom)! - factors.get(b.uom)!));

  const src = pickLatest(convertible);
  if (!src) return null;

  const factorSource = factors.get(src.uom)!;
  const unitPrice = (src.unitPrice * factorTarget) / factorSource;
  return { unitPrice, source: 'converted', priceListId, basedOnUom: src.uom };
}

/**
 * ดึงราคา 1 หน่วยของ (sku, uom) ใน price list ที่กำหนด
 * ถ้าไม่พบใน list ที่ขอ จะ fallback ไป default price list
 * คืน null ถ้าไม่พบราคาที่ใช้ได้เลย
 */
export function resolvePrice(
  data: PriceLookupData,
  input: ResolvePriceInput,
): ResolvePriceResult | null {
  const dateStr = toDateOnly(input.date ?? new Date());

  // 1) ลอง list ที่ขอก่อน
  const direct = resolveInList(data, input.sku, input.uom, input.priceListId, dateStr);
  if (direct) return { ...direct, fromFallback: false };

  // 2) fallback ไป default list (ถ้ามีและไม่ใช่ list เดิม)
  const defaultList = data.priceLists.find((l) => l.isDefault);
  if (defaultList && defaultList.id !== input.priceListId) {
    const fb = resolveInList(data, input.sku, input.uom, defaultList.id, dateStr);
    if (fb) return { ...fb, fromFallback: true };
  }

  return null;
}
