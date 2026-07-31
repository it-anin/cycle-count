/**
 * Seed ข้อมูลตัวอย่างสำหรับทดสอบ (default 5,000 SKU).
 * ปรับจำนวนได้: `SEED_SKU_COUNT=10000 pnpm db:seed`
 *
 * รันด้วย tsx — โหลด .env จาก root ก่อน
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // ไม่มี .env ก็ใช้ env ที่ export ไว้แล้ว
}

const { createDb } = await import('./client');
const schema = await import('./schema');

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL or DATABASE_URL must be set');

const SKU_COUNT = Number(process.env.SEED_SKU_COUNT ?? 5000);
const db = createDb(url);

const UOMS = ['PCS', 'PACK', 'CASE'] as const;
const PACK_FACTOR = 6; // 1 PACK = 6 PCS
const CASE_FACTOR = 24; // 1 CASE = 24 PCS

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log(`Seeding ${SKU_COUNT} SKUs ...`);

  // 1) price lists: default + ลูกค้าพิเศษ
  const [defaultList, wholesaleList] = await db
    .insert(schema.priceLists)
    .values([
      { name: 'Retail (default)', customerGroup: 'retail', isDefault: true },
      { name: 'Wholesale', customerGroup: 'wholesale', isDefault: false },
    ])
    .returning();

  // 2) products + barcodes + uom + prices (แบ่ง batch กันหน่วยความจำบวม)
  const BATCH = 500;
  for (let start = 0; start < SKU_COUNT; start += BATCH) {
    const end = Math.min(start + BATCH, SKU_COUNT);
    const productsBatch: (typeof schema.products.$inferInsert)[] = [];
    const barcodesBatch: (typeof schema.barcodes.$inferInsert)[] = [];
    const uomBatch: (typeof schema.uomConversions.$inferInsert)[] = [];
    const pricesBatch: (typeof schema.prices.$inferInsert)[] = [];

    for (let i = start; i < end; i++) {
      const sku = `SKU-${String(i + 1).padStart(6, '0')}`;
      productsBatch.push({
        sku,
        name: `สินค้าตัวอย่าง ${i + 1}`,
        baseUom: 'PCS',
        category: `CAT-${(i % 20) + 1}`,
        location: `A-${String((i % 30) + 1).padStart(2, '0')}-${String((i % 8) + 1).padStart(2, '0')}`,
      });

      // บาร์โค้ดต่อหน่วย
      barcodesBatch.push({ barcode: `88${String(i + 1).padStart(11, '0')}`, sku, uom: 'PCS' });
      barcodesBatch.push({ barcode: `87${String(i + 1).padStart(11, '0')}`, sku, uom: 'CASE' });

      // การแปลงหน่วย
      uomBatch.push({ sku, uom: 'PCS', factorToBase: '1' });
      uomBatch.push({ sku, uom: 'PACK', factorToBase: String(PACK_FACTOR) });
      uomBatch.push({ sku, uom: 'CASE', factorToBase: String(CASE_FACTOR) });

      // ราคา: default ตั้งราคาที่หน่วย PCS, wholesale ตั้งเฉพาะบาง SKU (เทส fallback)
      const base = rand(10, 500);
      pricesBatch.push({
        priceListId: defaultList!.id,
        sku,
        uom: 'PCS',
        unitPrice: String(base),
      });
      if (i % 3 === 0) {
        pricesBatch.push({
          priceListId: wholesaleList!.id,
          sku,
          uom: 'PCS',
          unitPrice: String(Math.round(base * 0.85)),
        });
      }
    }

    await db.insert(schema.products).values(productsBatch);
    await db.insert(schema.barcodes).values(barcodesBatch);
    await db.insert(schema.uomConversions).values(uomBatch);
    await db.insert(schema.prices).values(pricesBatch);
    console.log(`  products ${end}/${SKU_COUNT}`);
  }

  // 3) รอบนับตัวอย่าง — สร้างทั้งสองโหมดไว้ทดสอบ
  //    รอบ blind เป็นรอบที่ active (PDA จะหยิบรอบนี้) ส่วนรอบทวนไว้สลับทดสอบด้วยมือ
  const [session, recountSession] = await db
    .insert(schema.countSessions)
    .values([
      {
        code: 'CC-DEMO-A',
        name: 'รอบนับตัวอย่าง — คลัง A (ปิดยอด)',
        location: 'โซน A-12',
        mode: 'blind',
        status: 'active',
        priceListId: defaultList!.id,
        snapshotAt: new Date(),
        expectedSource: 'seed',
      },
      {
        code: 'CC-DEMO-A-R2',
        name: 'รอบทวนตัวอย่าง — คลัง A (เปิดยอด)',
        location: 'โซน A-12',
        mode: 'recount',
        status: 'draft',
        priceListId: defaultList!.id,
        snapshotAt: new Date(),
        expectedSource: 'seed',
      },
    ])
    .returning();

  // ยอดตั้งต้นใส่ให้ทั้งสองรอบ — รอบ blind มีข้อมูลใน DB แต่ API จะไม่ส่งลง PDA
  // ซึ่งเป็นเงื่อนไขที่ต้องทดสอบพอดี (มีข้อมูลอยู่ แต่ต้องไม่รั่ว)
  const expectedBatch: (typeof schema.expectedStock.$inferInsert)[] = [];
  const sampleN = Math.min(200, SKU_COUNT);
  for (const target of [session!, recountSession!]) {
    for (let i = 0; i < sampleN; i++) {
      expectedBatch.push({
        sessionId: target.id,
        sku: `SKU-${String(i + 1).padStart(6, '0')}`,
        uom: 'PCS',
        expectedQty: String(rand(0, 100)),
      });
    }
  }
  await db.insert(schema.expectedStock).values(expectedBatch);

  console.log(`Seed เสร็จสิ้น ✔  (blind: ${session!.code}, recount: ${recountSession!.code})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
