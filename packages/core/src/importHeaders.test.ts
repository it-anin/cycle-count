import { describe, expect, it } from 'vitest';

import { missingRequiredHeaders, normalizeRows } from './importHeaders';
import { parseRows } from './schemas';

describe('normalizeRows', () => {
  it('รับหัวคอลัมน์ภาษาไทย', () => {
    const rows = normalizeRows('products', [
      { รหัสสินค้า: 'AN-40118', ชื่อสินค้า: 'สายไฟ THW 1.5', หน่วยฐาน: 'ม้วน', ชั้นวาง: 'A-12-03' },
    ]);

    expect(rows[0]).toEqual({
      sku: 'AN-40118',
      name: 'สายไฟ THW 1.5',
      baseUom: 'ม้วน',
      location: 'A-12-03',
    });
  });

  it('หัวคอลัมน์อังกฤษหลายรูปแบบเข้าคีย์เดียวกัน', () => {
    for (const header of ['baseUom', 'Base UOM', 'base_uom', 'BASE-UOM', ' base uom ']) {
      expect(normalizeRows('products', [{ sku: 'A', name: 'B', [header]: 'PCS' }])[0]).toMatchObject(
        { baseUom: 'PCS' },
      );
    }
  });

  it('ตัดคอลัมน์ที่ไม่รู้จักทิ้ง', () => {
    const rows = normalizeRows('products', [
      { sku: 'A', name: 'B', หมายเหตุภายใน: 'อย่าเอาไปใช้', __EMPTY: 1 },
    ]);
    expect(rows[0]).toEqual({ sku: 'A', name: 'B' });
  });

  it('ช่องว่างล้วนถือเป็นไม่มีค่า ให้ default ของ Zod ทำงาน', () => {
    const rows = normalizeRows('products', [{ sku: 'A', name: 'B', baseUom: '   ' }]);
    expect(rows[0]).toEqual({ sku: 'A', name: 'B' });

    const parsed = parseRows('products', rows);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.valid[0]!.baseUom).toBe('PCS');
  });

  it('ต่อกับ parseRows ได้ครบทั้ง pipeline', () => {
    const raw = [
      { รหัสสินค้า: 'AN-1', ชื่อสินค้า: 'สินค้า ก', ตัวคูณ: 'ไม่เกี่ยว' },
      { รหัสสินค้า: '', ชื่อสินค้า: 'ไม่มีรหัส' },
    ];

    const { valid, errors } = parseRows('products', normalizeRows('products', raw));
    expect(valid).toHaveLength(1);
    expect(valid[0]!.sku).toBe('AN-1');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.row).toBe(3); // แถวที่ 2 ของข้อมูล = แถวที่ 3 ในไฟล์
  });

  it('แปลงไฟล์ราคาที่อ้าง price list ด้วยชื่อ', () => {
    const rows = normalizeRows('prices', [
      { กลุ่มราคา: 'Retail (default)', รหัสสินค้า: 'AN-1', หน่วย: 'ชิ้น', ราคา: '125.50' },
    ]);

    const { valid, errors } = parseRows('prices', rows);
    expect(errors).toHaveLength(0);
    expect(valid[0]).toMatchObject({ priceListName: 'Retail (default)', unitPrice: 125.5 });
  });
});

describe('missingRequiredHeaders', () => {
  it('ไฟล์ครบ', () => {
    expect(missingRequiredHeaders('barcodes', ['บาร์โค้ด', 'รหัสสินค้า', 'หน่วย'])).toEqual([]);
  });

  it('บอกว่าขาดคอลัมน์ไหน', () => {
    expect(missingRequiredHeaders('barcodes', ['บาร์โค้ด'])).toEqual(['sku', 'uom']);
  });

  it('ไฟล์ผิดชนิดไปเลย', () => {
    expect(missingRequiredHeaders('expected', ['ชื่อลูกค้า', 'ยอดขาย'])).toEqual([
      'sku',
      'uom',
      'expectedQty',
    ]);
  });
});
