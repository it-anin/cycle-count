import { describe, expect, it } from 'vitest';

import {
  applyScan,
  applyUnknownScan,
  bumpUnitQty,
  countedBaseQty,
  ledgerKey,
  ledgerTotals,
  removeRow,
  removeUnit,
  setUnitQty,
  toCountLines,
  variance,
  varianceKind,
  type BarcodeLookup,
  type LedgerRow,
} from './counting';

const AT = '2026-07-31T08:00:00.000Z';

/** แผง = หน่วยฐาน (factor 1) */
function strip(over: Partial<BarcodeLookup> = {}): BarcodeLookup {
  return {
    barcode: '8851111100098',
    sku: '100098',
    name: 'Antacil (แผง) 50x10',
    uom: 'แผง',
    factorToBase: 1,
    baseUom: 'แผง',
    expectedBaseQty: 580,
    location: 'A-12-03',
    ...over,
  };
}

/** กล่อง = 50 แผง — บาร์โค้ดคนละตัวของ SKU เดียวกัน */
const box = strip({ barcode: '8759991100098', uom: 'กล่อง', factorToBase: 50 });

describe('ledgerKey', () => {
  it('พบ SKU → คีย์คือ sku ไม่รวมหน่วย', () => {
    expect(ledgerKey('100098', '885')).toBe('100098');
  });

  it('ไม่พบ SKU → แยกตามบาร์โค้ด', () => {
    expect(ledgerKey(null, '999')).toBe('?|999');
  });
});

describe('applyScan', () => {
  it('ยิงครั้งแรกสร้างแถวใหม่บนสุด', () => {
    const rows = applyScan([], strip(), 1, AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: '100098', sku: '100098', expectedBaseQty: 580 });
    expect(rows[0]!.units).toEqual([
      { uom: 'แผง', factorToBase: 1, qty: 1, lastBarcode: '8851111100098', scanCount: 1 },
    ]);
  });

  it('ยิงซ้ำหน่วยเดิม บวกในหน่วยเดิม ไม่สร้างหน่วยใหม่', () => {
    let rows = applyScan([], strip(), 1, AT);
    rows = applyScan(rows, strip(), 1, AT);
    rows = applyScan(rows, strip(), 1, AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units).toHaveLength(1);
    expect(rows[0]!.units[0]!.qty).toBe(3);
    expect(rows[0]!.units[0]!.scanCount).toBe(3);
  });

  it('SKU เดียวกันคนละหน่วย รวมอยู่แถวเดียว แยกเป็นสองหน่วย', () => {
    let rows = applyScan([], strip(), 5, AT);
    rows = applyScan(rows, box, 3, AT);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.units.map((u) => u.uom)).toEqual(['กล่อง', 'แผง']);
    // 3 กล่อง × 50 + 5 แผง × 1
    expect(countedBaseQty(rows[0]!)).toBe(155);
  });

  it('ยิงแถวเก่าซ้ำแล้วดันขึ้นบนสุด — หัวใจของหน้าจอสมุดบัญชี', () => {
    let rows = applyScan([], strip(), 1, AT);
    rows = applyScan(rows, strip({ sku: '100039', barcode: 'B2', name: 'AMK' }), 1, AT);
    rows = applyScan(rows, strip(), 1, AT);

    expect(rows.map((r) => r.key)).toEqual(['100098', '100039']);
  });

  it('รับตัวคูณใหม่ถ้า master ถูกแก้ระหว่างรอบ', () => {
    let rows = applyScan([], box, 1, AT);
    rows = applyScan(rows, { ...box, factorToBase: 60 }, 1, AT);
    expect(rows[0]!.units[0]!.factorToBase).toBe(60);
    expect(countedBaseQty(rows[0]!)).toBe(120);
  });

  it('ไม่แก้ array เดิม', () => {
    const rows: LedgerRow[] = [];
    expect(applyScan(rows, strip(), 1, AT)).not.toBe(rows);
    expect(rows).toHaveLength(0);
  });
});

describe('applyUnknownScan', () => {
  it('บันทึกของที่ไม่พบใน master ไว้ให้แอดมินตาม', () => {
    const rows = applyUnknownScan([], '9999999999999', 1, AT);
    expect(rows[0]).toMatchObject({
      key: '?|9999999999999',
      sku: null,
      flagged: true,
      expectedBaseQty: null,
    });
    expect(rows[0]!.units[0]!.qty).toBe(1);
  });

  it('บาร์โค้ดไม่รู้จักคนละตัวแยกคนละแถว', () => {
    let rows = applyUnknownScan([], '999', 1, AT);
    rows = applyUnknownScan(rows, '888', 1, AT);
    expect(rows).toHaveLength(2);
  });
});

describe('แก้จำนวนย้อนหลัง', () => {
  const base = applyScan(applyScan([], box, 3, AT), strip(), 5, AT);

  it('setUnitQty แก้เฉพาะหน่วยที่ระบุ', () => {
    const rows = setUnitQty(base, '100098', 'แผง', 42, AT);
    const units = rows[0]!.units;
    expect(units.find((u) => u.uom === 'แผง')!.qty).toBe(42);
    expect(units.find((u) => u.uom === 'กล่อง')!.qty).toBe(3);
  });

  it('setUnitQty ไม่ยอมให้ติดลบ และกัน NaN', () => {
    expect(setUnitQty(base, '100098', 'แผง', -3, AT)[0]!.units.find((u) => u.uom === 'แผง')!.qty).toBe(0);
    expect(
      setUnitQty(base, '100098', 'แผง', Number.NaN, AT)[0]!.units.find((u) => u.uom === 'แผง')!.qty,
    ).toBe(0);
  });

  it('bumpUnitQty หยุดที่ 0', () => {
    const rows = bumpUnitQty(base, '100098', 'กล่อง', -99, AT);
    expect(rows[0]!.units.find((u) => u.uom === 'กล่อง')!.qty).toBe(0);
  });

  it('bumpUnitQty กับหน่วยที่ไม่มีอยู่ คืนค่าเดิม', () => {
    expect(bumpUnitQty(base, '100098', 'ลัง', 1, AT)).toBe(base);
  });

  it('removeUnit ลบเฉพาะหน่วยนั้น แถวยังอยู่ถ้ายังเหลือหน่วยอื่น', () => {
    const rows = removeUnit(base, '100098', 'กล่อง', AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units.map((u) => u.uom)).toEqual(['แผง']);
  });

  it('removeUnit ตัวสุดท้าย ลบทั้งแถว', () => {
    let rows = removeUnit(base, '100098', 'กล่อง', AT);
    rows = removeUnit(rows, '100098', 'แผง', AT);
    expect(rows).toHaveLength(0);
  });

  it('removeRow ลบทั้งแถว', () => {
    expect(removeRow(base, '100098')).toHaveLength(0);
  });
});

describe('ผลต่างคิดที่หน่วยฐานเสมอ', () => {
  it('ยิงกล่องอย่างเดียว — 12 กล่อง × 50 = 600 เทียบ 580 เกิน 20', () => {
    const rows = applyScan([], box, 12, AT);
    expect(countedBaseQty(rows[0]!)).toBe(600);
    expect(variance(rows[0]!)).toBe(20);
    expect(varianceKind(rows[0]!)).toBe('over');
  });

  it('ผสมสองหน่วยในแถวเดียว ผลต่างคิดรวมทั้ง SKU', () => {
    let rows = applyScan([], box, 11, AT); // 550
    rows = applyScan(rows, strip(), 30, AT); // +30 = 580
    expect(countedBaseQty(rows[0]!)).toBe(580);
    expect(variance(rows[0]!)).toBe(0);
    expect(varianceKind(rows[0]!)).toBe('match');
  });

  it('ขาด', () => {
    const rows = applyScan([], strip(), 500, AT);
    expect(variance(rows[0]!)).toBe(-80);
    expect(varianceKind(rows[0]!)).toBe('short');
  });

  it('ไม่มียอดตั้งต้น → ยังตัดสินไม่ได้', () => {
    const rows = applyScan([], strip({ expectedBaseQty: null }), 5, AT);
    expect(variance(rows[0]!)).toBeNull();
    expect(varianceKind(rows[0]!)).toBe('unknown');
  });

  it('แถว flagged ถือเป็น unknown', () => {
    const rows = applyUnknownScan([], '999', 3, AT);
    expect(varianceKind(rows[0]!)).toBe('unknown');
  });
});

describe('รอบปิดยอด (blind)', () => {
  const blind = (over: Partial<BarcodeLookup> = {}) => strip({ expectedBaseQty: null, ...over });

  it('ไม่มีแถวไหนอ้างผลต่างได้', () => {
    let rows = applyScan([], blind(), 36, AT);
    rows = applyScan(rows, blind({ sku: 'S2', barcode: 'B2' }), 8, AT);
    for (const row of rows) {
      expect(variance(row)).toBeNull();
      expect(varianceKind(row)).toBe('unknown');
    }
  });

  it('ยอดรวมหน่วยฐานยังใช้ได้ แต่ไม่แบ่ง ตรง/ขาด/เกิน', () => {
    let rows = applyScan([], blind(), 36, AT);
    rows = applyScan(rows, blind({ sku: 'S2', barcode: 'B2' }), 8, AT);
    expect(ledgerTotals(rows)).toMatchObject({
      skuCount: 2,
      totalBaseQty: 44,
      matched: 0,
      short: 0,
      over: 0,
      withoutExpected: 2,
    });
  });
});

describe('ledgerTotals', () => {
  it('นับ SKU และหน่วยย่อยแยกกัน', () => {
    let rows = applyScan([], box, 2, AT); // 100
    rows = applyScan(rows, strip(), 5, AT); // +5 → SKU เดียว 2 หน่วย
    rows = applyScan(rows, strip({ sku: 'S2', barcode: 'B2', expectedBaseQty: 10 }), 10, AT);

    const t = ledgerTotals(rows);
    expect(t.skuCount).toBe(2);
    expect(t.lineCount).toBe(3);
    expect(t.totalBaseQty).toBe(115);
  });

  it('แยกกลุ่ม ตรง / ขาด / เกิน / ไม่รู้จัก', () => {
    let rows = applyScan([], strip({ expectedBaseQty: 36 }), 36, AT);
    rows = applyScan(rows, strip({ sku: 'S2', barcode: 'B2', expectedBaseQty: 10 }), 8, AT);
    rows = applyScan(rows, strip({ sku: 'S3', barcode: 'B3', expectedBaseQty: 10 }), 13, AT);
    rows = applyScan(rows, strip({ sku: 'S4', barcode: 'B4', expectedBaseQty: null }), 4, AT);
    rows = applyUnknownScan(rows, '999', 1, AT);

    expect(ledgerTotals(rows)).toMatchObject({
      matched: 1,
      short: 1,
      over: 1,
      withoutExpected: 1,
      unknown: 1,
      skuCount: 5,
    });
  });

  it('สมุดเปล่า', () => {
    expect(ledgerTotals([])).toMatchObject({ skuCount: 0, lineCount: 0, totalBaseQty: 0 });
  });
});

describe('toCountLines', () => {
  it('แยกหนึ่งบรรทัดต่อหนึ่งหน่วย เก็บหลักฐานว่าหยิบอะไรมา', () => {
    let rows = applyScan([], box, 3, AT);
    rows = applyScan(rows, strip(), 5, AT);

    expect(toCountLines(rows)).toEqual([
      {
        lineKey: '100098|แผง',
        sku: '100098',
        uom: 'แผง',
        factorToBase: 1,
        scannedBarcode: '8851111100098',
        countedQty: 5,
        flagged: false,
        countedAt: AT,
      },
      {
        lineKey: '100098|กล่อง',
        sku: '100098',
        uom: 'กล่อง',
        factorToBase: 50,
        scannedBarcode: '8759991100098',
        countedQty: 3,
        flagged: false,
        countedAt: AT,
      },
    ]);
  });

  it('lineKey ไม่ซ้ำกันภายในการส่งครั้งเดียว — ไม่งั้น upsert ฝั่ง server ล้ม', () => {
    let rows = applyScan([], box, 1, AT);
    rows = applyScan(rows, strip(), 1, AT);
    rows = applyScan(rows, strip({ sku: 'S2', barcode: 'B2' }), 1, AT);
    rows = applyUnknownScan(rows, '999', 1, AT);

    const keys = toCountLines(rows).map((l) => l.lineKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('แถวที่ไม่พบ SKU ใช้ ?|barcode เป็น lineKey', () => {
    const rows = applyUnknownScan([], '999', 2, AT);
    expect(toCountLines(rows)[0]).toMatchObject({ lineKey: '?|999', sku: null, countedQty: 2 });
  });
});
