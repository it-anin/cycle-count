/**
 * เทสของ schema ที่กัน endpoint เขียนข้อมูล
 *
 * `countLinePayload` / `submitCountBody` เป็นด่านเดียวที่กั้นระหว่าง PDA กับ `count_lines`
 * ถ้าด่านนี้หลวม ข้อมูลเสียจะเข้าไปถึง DB โดยไม่มีอะไรจับได้
 *
 * เทสส่วนใหญ่ในไฟล์นี้บันทึก**พฤติกรรมปัจจุบัน** ไม่ใช่พฤติกรรมที่อยากได้ทั้งหมด
 * ช่องที่รู้ว่าหลวมแต่ยังไม่แก้ ทำเครื่องหมายไว้ด้วย `it.todo` พร้อมเหตุผล
 * เพื่อให้เห็นในผลรันโดยไม่ทำให้ CI แดง
 */
import { describe, expect, it } from 'vitest';

import {
  countLinePayload,
  expectedImportRow,
  parseRows,
  productImportRow,
  submitCountBody,
  uomImportRow,
} from './schemas';

const AT = '2026-07-31T04:00:00.000Z';

const line = (over: Record<string, unknown> = {}) => ({
  lineKey: '100098|8850001000018',
  sku: '100098',
  uom: 'แผง',
  factorToBase: 1,
  scannedBarcode: '8850001000018',
  countedQty: 12,
  flagged: false,
  countedAt: AT,
  ...over,
});

describe('countLinePayload', () => {
  it('รับ payload ปกติจาก PDA', () => {
    const result = countLinePayload.safeParse(line());

    expect(result.success).toBe(true);
  });

  it('แถวที่ไม่พบใน master ส่ง sku เป็น null ได้', () => {
    const result = countLinePayload.safeParse(line({ sku: null, flagged: true }));

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sku).toBeNull();
  });

  it('ตัวเลขที่มาเป็น string ถูก coerce ให้ (Excel/JSON ส่งมาแบบนี้ได้)', () => {
    const result = countLinePayload.safeParse(line({ factorToBase: '50', countedQty: '3' }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.factorToBase).toBe(50);
      expect(result.data.countedQty).toBe(3);
    }
  });

  it('นับได้ 0 ต้องผ่าน — SKU ที่ยอดเป็น 0 ก็ต้องนับได้', () => {
    expect(countLinePayload.safeParse(line({ countedQty: 0 })).success).toBe(true);
  });

  it('จำนวนติดลบไม่ผ่าน', () => {
    expect(countLinePayload.safeParse(line({ countedQty: -1 })).success).toBe(false);
  });

  it('ตัวคูณเป็น 0 ไม่ผ่าน — ถ้าหลุดไปจะทำให้ยอดหน่วยฐานเป็น 0 ทั้งแถว', () => {
    expect(countLinePayload.safeParse(line({ factorToBase: 0 })).success).toBe(false);
  });

  it('ตัวคูณติดลบไม่ผ่าน', () => {
    expect(countLinePayload.safeParse(line({ factorToBase: -1 })).success).toBe(false);
  });

  it('lineKey ว่างไม่ผ่าน — เป็นคีย์ที่ใช้ upsert', () => {
    expect(countLinePayload.safeParse(line({ lineKey: '   ' })).success).toBe(false);
  });

  it('countedAt ที่ไม่ใช่ ISO datetime ไม่ผ่าน', () => {
    expect(countLinePayload.safeParse(line({ countedAt: '31/07/2026' })).success).toBe(false);
  });

  it('ฟิลด์เกินมาถูกตัดทิ้ง ไม่ใช่ปล่อยผ่านไปถึง DB', () => {
    const result = countLinePayload.safeParse(line({ countedBy: 'ผู้ใช้ปลอม' }));

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('countedBy');
  });

  it.todo(
    'factorToBase/countedQty ควรมีขอบบน — ตอนนี้รับ 1e30 ได้ แล้วไปชน numeric(14,4) ' +
      'กลายเป็น Postgres overflow ที่ withApi แปลงเป็น 500 (ดูข้อ M6 ในแผน)',
  );

  it.todo(
    'ควรมี refinement ระหว่าง sku กับ flagged — ตอนนี้ { sku: null, flagged: false } ' +
      'ผ่าน validate แล้วไปชน FK ที่ count_lines.sku กลายเป็น 500',
  );
});

describe('submitCountBody', () => {
  it('รับ payload ที่มีหลายบรรทัด', () => {
    const result = submitCountBody.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      lines: [line(), line({ lineKey: 'x|y' })],
    });

    expect(result.success).toBe(true);
  });

  it('sessionId ต้องเป็น uuid', () => {
    const result = submitCountBody.safeParse({ sessionId: 'CC-2026-07', lines: [line()] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('sessionId'))).toBe(true);
    }
  });

  it('ส่งมาโดยไม่มีบรรทัดเลยไม่ผ่าน', () => {
    const result = submitCountBody.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      lines: [],
    });

    expect(result.success).toBe(false);
  });

  it('เกิน 2,000 บรรทัดไม่ผ่าน', () => {
    const result = submitCountBody.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      lines: Array.from({ length: 2001 }, (_, i) => line({ lineKey: `k${i}` })),
    });

    expect(result.success).toBe(false);
  });

  it('2,000 บรรทัดพอดีผ่าน', () => {
    const result = submitCountBody.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      lines: Array.from({ length: 2000 }, (_, i) => line({ lineKey: `k${i}` })),
    });

    expect(result.success).toBe(true);
  });

  it('บรรทัดเดียวผิด ทั้ง payload ต้องไม่ผ่าน — ไม่ใช่บันทึกบางส่วน', () => {
    const result = submitCountBody.safeParse({
      sessionId: '22222222-2222-4222-8222-222222222222',
      lines: [line(), line({ countedQty: -5 })],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes(1))).toBe(true);
    }
  });
});

describe('parseRows', () => {
  it('เลขแถวเริ่มที่ 2 (แถวแรกถัดจาก header)', () => {
    const { valid, errors } = parseRows('uom', [
      { sku: '100098', uom: 'กล่อง', factorToBase: 50 },
      { sku: '', uom: 'แผง', factorToBase: 1 },
    ]);

    expect(valid).toHaveLength(1);
    expect(errors).toEqual([{ row: 3, message: expect.stringContaining('sku') }]);
  });

  it('แถวที่ผ่านกับแถวที่ผิดถูกแยกกัน ไม่ทิ้งทั้งไฟล์', () => {
    const { valid, errors } = parseRows('uom', [
      { sku: 'A', uom: 'แผง', factorToBase: 1 },
      { sku: 'B', uom: 'กล่อง', factorToBase: 'ไม่ใช่ตัวเลข' },
      { sku: 'C', uom: 'โหล', factorToBase: 12 },
    ]);

    expect(valid.map((r) => r.sku)).toEqual(['A', 'C']);
    expect(errors.map((e) => e.row)).toEqual([3]);
  });
});

describe('schema ของไฟล์ import', () => {
  it('productImportRow: baseUom ที่ไม่ได้กรอกได้ค่าเริ่มต้น PCS', () => {
    const result = productImportRow.safeParse({ sku: '100098', name: 'ยาแก้ไอ' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.baseUom).toBe('PCS');
  });

  it('productImportRow: active แปลงจากคำไทยและอังกฤษได้', () => {
    const parse = (active: unknown) =>
      productImportRow.parse({ sku: 'A', name: 'n', active }).active;

    expect(parse(undefined)).toBe(true);
    expect(parse('ปิด')).toBe(false);
    expect(parse('false')).toBe(false);
    expect(parse(0)).toBe(false);
    expect(parse('ใช้งาน')).toBe(true);
  });

  it('uomImportRow: ตัวคูณต้องมากกว่า 0', () => {
    expect(uomImportRow.safeParse({ sku: 'A', uom: 'แผง', factorToBase: 0 }).success).toBe(false);
    expect(uomImportRow.safeParse({ sku: 'A', uom: 'แผง', factorToBase: 1 }).success).toBe(true);
  });

  it.todo(
    'expectedImportRow.expectedQty ควรมี .nonnegative() เหมือน unitPrice — ' +
      'ตอนนี้ยอดตั้งต้นติดลบ import เข้าได้เงียบ ๆ (ดูข้อ M6 ในแผน)',
  );

  it('expectedImportRow: ยอด 0 ต้อง import ได้ (SKU ที่ของหมด)', () => {
    expect(expectedImportRow.safeParse({ sku: 'A', uom: 'แผง', expectedQty: 0 }).success).toBe(
      true,
    );
  });
});
