import { describe, expect, it } from 'vitest';

import { resolvePrice, type PriceLookupData } from './pricing';

const RETAIL = 'list-retail';
const WHOLESALE = 'list-wholesale';

const conversions = [
  { sku: 'A', uom: 'PCS', factorToBase: 1 },
  { sku: 'A', uom: 'PACK', factorToBase: 6 },
  { sku: 'A', uom: 'CASE', factorToBase: 24 },
];

const priceLists = [
  { id: RETAIL, isDefault: true },
  { id: WHOLESALE, isDefault: false },
];

function data(prices: PriceLookupData['prices']): PriceLookupData {
  return { prices, conversions, priceLists };
}

const on = (d: string) => new Date(`${d}T00:00:00Z`);

describe('resolvePrice', () => {
  it('ตรงหน่วยพอดี (exact)', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r).toMatchObject({ unitPrice: 10, source: 'exact', fromFallback: false });
  });

  it('แปลงหน่วยจากราคา PCS → CASE (24 ชิ้น)', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'CASE', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r?.unitPrice).toBe(240);
    expect(r?.source).toBe('converted');
    expect(r?.basedOnUom).toBe('PCS');
  });

  it('แปลงหน่วยจากราคา CASE → PACK', () => {
    // ราคา CASE = 240 → per base = 10 → PACK (6) = 60
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'CASE', unitPrice: 240, effectiveFrom: '2024-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PACK', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r?.unitPrice).toBe(60);
    expect(r?.source).toBe('converted');
  });

  it('ใช้ราคาของ price list ตามลูกค้าเมื่อมี', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: null },
      { priceListId: WHOLESALE, sku: 'A', uom: 'PCS', unitPrice: 8, effectiveFrom: '2024-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: WHOLESALE, date: on('2026-07-24') });
    expect(r).toMatchObject({ unitPrice: 8, fromFallback: false, priceListId: WHOLESALE });
  });

  it('fallback ไป default list เมื่อ list ที่ขอไม่มีราคา', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: WHOLESALE, date: on('2026-07-24') });
    expect(r).toMatchObject({ unitPrice: 10, fromFallback: true, priceListId: RETAIL });
  });

  it('ไม่ใช้ราคาที่ยังไม่มีผล/หมดอายุ', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 12, effectiveFrom: '2027-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r).toBeNull();
  });

  it('ราคาใหม่ (effectiveFrom ล่าสุด) ทับราคาเก่า', () => {
    const d = data([
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 10, effectiveFrom: '2024-01-01', effectiveTo: null },
      { priceListId: RETAIL, sku: 'A', uom: 'PCS', unitPrice: 15, effectiveFrom: '2026-01-01', effectiveTo: null },
    ]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r?.unitPrice).toBe(15);
  });

  it('คืน null เมื่อไม่มีราคาเลย', () => {
    const d = data([]);
    const r = resolvePrice(d, { sku: 'A', uom: 'PCS', priceListId: RETAIL, date: on('2026-07-24') });
    expect(r).toBeNull();
  });
});
