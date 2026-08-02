/**
 * เทสการเขียน master data แบบ batch กับ Postgres จริง
 *
 * ที่ต้องยิงใส่ DB จริงเพราะเรื่องที่จะพิสูจน์คือ **ขอบเขตของ transaction**
 * ซึ่ง stub จำลองไม่ได้ — ต้องเห็นว่า batch ที่ล้มแล้วข้อมูลอยู่หรือหายจริง ๆ
 *
 * รันด้วย: pnpm --filter @cycle-count/web test:integration
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { upsertExpectedStock } from '@/server/import/upsert';
import {
  countExpected,
  createTestSession,
  dropTestSession,
  sweepLeftoverTestSessions,
  type TestSession,
} from '@/test/integration';

const created: TestSession[] = [];

/** SKU ที่มีอยู่จริงใน master — expected_stock มี FK ไป products */
let realSkus: string[] = [];

beforeAll(async () => {
  await sweepLeftoverTestSessions();

  const rows = (await db.execute(sql`
    SELECT sku FROM cycle_count.products ORDER BY sku LIMIT 1200
  `)) as unknown as { sku: string }[];

  realSkus = rows.map((r) => r.sku);
  if (realSkus.length < 600) {
    throw new Error('ต้องมี products อย่างน้อย 600 แถวเพื่อทดสอบการแบ่ง batch (BATCH = 500)');
  }
}, 60_000);

afterAll(async () => {
  for (const s of created) await dropTestSession(s);
}, 60_000);

async function newSession(): Promise<TestSession> {
  const s = await createTestSession();
  created.push(s);
  return s;
}

const rowsFor = (skus: string[]) =>
  skus.map((sku, i) => ({ sku, uom: 'PCS', expectedQty: i + 1 }));

describe('upsertExpectedStock', () => {
  it(
    'เขียนครบทุกแถวแม้เกินหนึ่ง batch (BATCH = 500)',
    async () => {
      const session = await newSession();
      const skus = realSkus.slice(0, 1100);

      const result = await upsertExpectedStock(session.id, rowsFor(skus));

      expect(result.written).toBe(skus.length);
      expect(await countExpected(session.id)).toBe(skus.length);
    },
    180_000,
  );

  it(
    'รายงานความคืบหน้าเป็นช่วง ๆ ไม่ใช่ทีเดียวตอนจบ',
    async () => {
      const session = await newSession();
      const skus = realSkus.slice(0, 1100);
      const progress: number[] = [];

      await upsertExpectedStock(session.id, rowsFor(skus), async (written) => {
        progress.push(written);
        await Promise.resolve();
      });

      // 1100 แถว ÷ 500 = 3 batch
      expect(progress).toEqual([500, 1000, 1100]);
    },
    180_000,
  );

  it(
    'batch ที่ล้มกลางทาง — batch ก่อนหน้าต้องอยู่ครบ ไม่ใช่ครึ่ง ๆ กลาง ๆ',
    async () => {
      const session = await newSession();
      const skus = realSkus.slice(0, 1100);
      let seen = 0;

      await expect(
        upsertExpectedStock(session.id, rowsFor(skus), async (written) => {
          seen = written;
          await Promise.resolve();
          // ล้มหลัง batch ที่สองเขียนเสร็จ
          if (written >= 1000) throw new Error('จำลอง lambda ถูกฆ่า');
        }),
      ).rejects.toThrow('จำลอง lambda ถูกฆ่า');

      expect(seen).toBe(1000);
      // สอง batch แรกต้อง commit ครบ 1000 แถวพอดี — ไม่ใช่ 1000±บางส่วน
      expect(await countExpected(session.id)).toBe(1000);
    },
    180_000,
  );

  it(
    'อัปโหลดซ้ำเขียนทับได้ ไม่สะสมแถว',
    async () => {
      const session = await newSession();
      const skus = realSkus.slice(0, 600);

      await upsertExpectedStock(session.id, rowsFor(skus));
      await upsertExpectedStock(session.id, rowsFor(skus));

      expect(await countExpected(session.id)).toBe(skus.length);
    },
    180_000,
  );
});
