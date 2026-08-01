/**
 * อัปโหลดรายงาน R05106 (บาร์โค้ด → หน่วย + ตัวคูณ) เข้า cycle_count.barcode_units
 *
 *   pnpm --filter @cycle-count/db upload:barcode-units R05106.CSV
 *
 * ทำไมไม่ใช้ supabase-js เหมือนสคริปต์ upload ตัวอื่นของทีม:
 * PostgREST ของ Supabase เปิดเฉพาะ schema `public` ตามค่าเริ่มต้น แต่ตารางนี้อยู่ใน
 * `cycle_count` จึงต้องต่อ Postgres ตรงด้วย DIRECT_URL — ซึ่งเร็วกว่ามากสำหรับหมื่นแถวด้วย
 *
 * ไฟล์จาก POS เป็น UTF-8 with BOM และมี 27 คอลัมน์ เราใช้แค่ 5
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // ไม่มี .env ก็ใช้ env ที่ export ไว้แล้ว
}

const { createDb } = await import('./client');
const { barcodeUnits } = await import('./schema');
const { sql } = await import('drizzle-orm');

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('ต้องตั้ง DIRECT_URL หรือ DATABASE_URL ใน .env ก่อน');

const file = process.argv[2];
if (!file) throw new Error('ระบุไฟล์: pnpm upload:barcode-units <path/to/R05106.CSV>');

/** คอลัมน์ที่ใช้จริงจาก 27 คอลัมน์ของรายงาน */
const COLS = {
  barcode: 'CF_BARCODE',
  sku: 'CF_ITEMID',
  name: 'CF_ITEMNAME',
  uom: 'CF_UNITNAME',
  factor: 'CF_BASEMULTIPLE',
  price: 'CF_FMLPRICE',
} as const;

/**
 * แยก CSV ทีละบรรทัด
 *
 * `"` นับเป็นตัวคั่นเฉพาะตอนอยู่ **ต้นฟิลด์** เท่านั้น ถ้าโผล่กลางฟิลด์ถือเป็นอักขระธรรมดา
 * — ชื่อสินค้าในไฟล์นี้ใช้ `"` เป็นหน่วยนิ้วจริง เช่น `Klean Gauze 2" x 2" (10ชิ้น/bx)`
 * ถ้าตีความว่าเปิด quote คอลัมน์จะเลื่อนทั้งแถวแล้วข้อมูลหายเงียบ ๆ (เจอ 207 แถวตอนเทส)
 * พฤติกรรมนี้ตรงกับ csv module ของ Python ที่ใช้ตรวจไฟล์
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let atFieldStart = true;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
      continue;
    }

    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
      atFieldStart = true;
    } else {
      cur += ch;
      atFieldStart = false;
    }
  }

  out.push(cur);
  return out;
}

interface Row {
  barcode: string;
  sku: string;
  name: string | null;
  uom: string;
  factorToBase: string;
  price: string | null;
}

const numeric = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
};

async function readRows(path: string): Promise<{ rows: Row[]; skipped: number }> {
  const stream = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let index: Record<keyof typeof COLS, number> | null = null;
  const rows: Row[] = [];
  /** บาร์โค้ดซ้ำในไฟล์เดียวทำให้ ON CONFLICT ล้ม — เอาแถวหลังสุดชนะ */
  const seen = new Map<string, number>();
  let skipped = 0;

  for await (const raw of stream) {
    // ตัด BOM (U+FEFF) ออกจากบรรทัดแรก ไม่งั้นชื่อคอลัมน์แรกจะกลายเป็น "<BOM>CF_BARCODE"
    // แล้วหาไม่เจอตอน resolve index — เขียนเป็น escape ไม่ใช่ตัวอักษรจริง จะได้เห็นด้วยตาว่ามีอยู่
    const line = header === null ? raw.replace(/^\uFEFF/, '') : raw;
    if (!line.trim()) continue;

    const cells = splitCsvLine(line);

    if (header === null) {
      header = cells.map((c) => c.trim());
      const find = (name: string) => {
        const i = header!.indexOf(name);
        if (i < 0) throw new Error(`ไฟล์ขาดคอลัมน์ ${name}`);
        return i;
      };
      index = {
        barcode: find(COLS.barcode),
        sku: find(COLS.sku),
        name: find(COLS.name),
        uom: find(COLS.uom),
        factor: find(COLS.factor),
        price: find(COLS.price),
      };
      continue;
    }

    const barcode = (cells[index!.barcode] ?? '').trim();
    const sku = (cells[index!.sku] ?? '').trim();
    const uom = (cells[index!.uom] ?? '').trim();
    const factor = numeric(cells[index!.factor]);

    // ตัวคูณต้องเป็นบวก — 0 จะทำให้คำนวณหน่วยฐานเพี้ยนทั้งรอบนับ
    if (!barcode || !sku || !uom || factor === null || Number(factor) <= 0) {
      skipped++;
      continue;
    }

    const row: Row = {
      barcode,
      sku,
      name: (cells[index!.name] ?? '').trim() || null,
      uom,
      factorToBase: factor,
      price: numeric(cells[index!.price]),
    };

    const at = seen.get(barcode);
    if (at === undefined) {
      seen.set(barcode, rows.length);
      rows.push(row);
    } else {
      rows[at] = row;
    }
  }

  return { rows, skipped };
}

async function main() {
  const path = resolve(process.cwd(), file!);
  console.log(`อ่าน ${path} ...`);

  const { rows, skipped } = await readRows(path);
  console.log(`  ใช้ได้ ${rows.length} แถว, ข้าม ${skipped} แถว`);
  if (rows.length === 0) throw new Error('ไม่มีแถวที่ใช้ได้เลย');

  const db = createDb(url!);
  const BATCH = 500;

  for (let i = 0; i < rows.length; i += BATCH) {
    await db
      .insert(barcodeUnits)
      .values(rows.slice(i, i + BATCH).map((r) => ({ ...r, uploadedAt: new Date() })))
      .onConflictDoUpdate({
        target: barcodeUnits.barcode,
        set: {
          sku: sql`excluded.sku`,
          name: sql`excluded.name`,
          uom: sql`excluded.uom`,
          factorToBase: sql`excluded.factor_to_base`,
          price: sql`excluded.price`,
          uploadedAt: sql`excluded.uploaded_at`,
        },
      });
    process.stdout.write(`\r  เขียนแล้ว ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  console.log('\nเสร็จสิ้น ✔');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
