/**
 * Zod schemas สำหรับ validate แถวจาก Excel ก่อน upsert ลง DB
 * ใช้ z.coerce กับตัวเลข เพราะค่าจาก Excel อาจมาเป็น string
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/** ไฟล์ SKU master */
export const productImportRow = z.object({
  sku: nonEmpty,
  name: nonEmpty,
  baseUom: z.string().trim().min(1).default('PCS'),
  category: z.string().trim().optional(),
  /** ตำแหน่งชั้นวาง เช่น 'A-12-03' */
  location: z.string().trim().optional(),
  active: z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined) return true;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return !['0', 'false', 'no', 'inactive', 'ปิด'].includes(v.trim().toLowerCase());
    }),
});

/** ไฟล์บาร์โค้ด */
export const barcodeImportRow = z.object({
  barcode: nonEmpty,
  sku: nonEmpty,
  uom: nonEmpty,
});

/** ไฟล์การแปลงหน่วย */
export const uomImportRow = z.object({
  sku: nonEmpty,
  uom: nonEmpty,
  factorToBase: z.coerce.number().positive(),
});

/** ไฟล์ราคา (อ้าง price list ด้วยชื่อ แล้ว resolve เป็น id ตอน import) */
export const priceImportRow = z.object({
  priceListName: nonEmpty,
  sku: nonEmpty,
  uom: nonEmpty,
  unitPrice: z.coerce.number().nonnegative(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().optional(),
});

/** ไฟล์ยอดตั้งต้น (expected snapshot) ของรอบนับ */
export const expectedImportRow = z.object({
  sku: nonEmpty,
  uom: nonEmpty,
  expectedQty: z.coerce.number(),
});

/* -------------------------------------------------------------------------- */
/*                        Payload ที่ PDA ส่งขึ้น server                        */
/* -------------------------------------------------------------------------- */

/** ต้องตรงกับ CountLinePayload ใน ./counting */
export const countLinePayload = z.object({
  lineKey: nonEmpty,
  sku: z.string().trim().min(1).nullable(),
  uom: nonEmpty,
  /** ตัวคูณของหน่วยนี้ ณ เวลาที่นับ — เก็บไว้ให้รายงานคำนวณย้อนหลังได้ตรงกัน */
  factorToBase: z.coerce.number().positive(),
  scannedBarcode: nonEmpty,
  countedQty: z.coerce.number().nonnegative(),
  flagged: z.boolean(),
  countedAt: z.string().datetime(),
});

/** จำกัด 2,000 บรรทัดต่อคำขอ — หนึ่งรอบนับปกติไม่ถึง และกัน payload บวมเกินไป */
export const submitCountBody = z.object({
  sessionId: z.string().uuid(),
  /** APK เก่าไม่ส่ง field นี้ ฝั่ง server ยังรับได้แบบ legacy */
  catalogVersion: z.string().trim().min(1).max(200).optional(),
  lines: z.array(countLinePayload).min(1).max(2000),
});

export type SubmitCountBody = z.infer<typeof submitCountBody>;

export type ProductImportRow = z.infer<typeof productImportRow>;
export type BarcodeImportRow = z.infer<typeof barcodeImportRow>;
export type UomImportRow = z.infer<typeof uomImportRow>;
export type PriceImportRow = z.infer<typeof priceImportRow>;
export type ExpectedImportRow = z.infer<typeof expectedImportRow>;

export const importRowSchemas = {
  products: productImportRow,
  barcodes: barcodeImportRow,
  uom: uomImportRow,
  prices: priceImportRow,
  expected: expectedImportRow,
} as const;

export type ImportKind = keyof typeof importRowSchemas;

export interface ParsedRowError {
  row: number;
  message: string;
}

export interface ParseResult<T> {
  valid: T[];
  errors: ParsedRowError[];
}

/**
 * validate หลายแถวด้วย schema ของชนิดไฟล์ที่เลือก
 * คืนทั้งแถวที่ผ่าน และ error รายแถว (row เริ่มที่ 2 = แถวข้อมูลแรกถัดจาก header)
 */
export function parseRows<K extends ImportKind>(
  kind: K,
  rows: unknown[],
  startRow = 2,
): ParseResult<z.infer<(typeof importRowSchemas)[K]>> {
  const schema = importRowSchemas[kind];
  const valid: z.infer<(typeof importRowSchemas)[K]>[] = [];
  const errors: ParsedRowError[] = [];

  rows.forEach((raw, i) => {
    const result = schema.safeParse(raw);
    if (result.success) {
      valid.push(result.data as z.infer<(typeof importRowSchemas)[K]>);
    } else {
      const msg = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
        .join('; ');
      errors.push({ row: startRow + i, message: msg });
    }
  });

  return { valid, errors };
}
