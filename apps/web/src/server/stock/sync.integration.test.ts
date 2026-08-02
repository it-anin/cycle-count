/**
 * เทส snapshotExpected() กับ Postgres จริง
 *
 * ต้องยิงใส่ DB จริงเพราะฟังก์ชันนี้อ่าน `public.stock` ของระบบ POS
 * — ตารางปลอมที่เราสร้างเองจะไม่มีกับดักแบบเดียวกับของจริง (ดู src/test/integration.ts)
 *
 * รันด้วย: pnpm --filter @cycle-count/web test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { snapshotExpected } from '@/server/stock/sync';
import {
  busiestBranches,
  countExpected,
  createTestSession,
  dropTestSession,
  expectedSkus,
  sweepLeftoverTestSessions,
  type TestSession,
} from '@/test/integration';

let branchA: string;
let branchB: string;
const created: TestSession[] = [];

beforeAll(async () => {
  await sweepLeftoverTestSessions();

  const branches = await busiestBranches(2);
  if (branches.length === 0) {
    throw new Error('ไม่มีสาขาใน public.stock — เทสชุดนี้ต้องใช้ DB ที่มีข้อมูลจริง');
  }
  branchA = branches[0]!.branch;
  branchB = branches[1]?.branch ?? branches[0]!.branch;
}, 60_000);

afterAll(async () => {
  for (const s of created) await dropTestSession(s);
}, 60_000);

/** สร้าง session แล้วจำไว้ให้ afterAll เก็บกวาด */
async function newSession(): Promise<TestSession> {
  const s = await createTestSession();
  created.push(s);
  return s;
}

describe('snapshotExpected', () => {
  it(
    'ถ่ายยอดตั้งต้นของสาขาลง expected_stock และตั้ง snapshot_at',
    async () => {
      const session = await newSession();

      const result = await snapshotExpected(session.id, branchA);

      expect(result.rows).toBeGreaterThan(0);
      expect(result.snapshotAt).toBeInstanceOf(Date);
      expect(await countExpected(session.id)).toBe(result.rows);
    },
    120_000,
  );

  it(
    'เรียกซ้ำสาขาเดิมได้จำนวนแถวเท่าเดิม ไม่สะสมทับ',
    async () => {
      const session = await newSession();

      const first = await snapshotExpected(session.id, branchA);
      const second = await snapshotExpected(session.id, branchA);

      expect(second.rows).toBe(first.rows);
      expect(await countExpected(session.id)).toBe(first.rows);
    },
    180_000,
  );

  /*
   * นี่คือบั๊ก C4 — ก่อนแก้ใช้ INSERT ... ON CONFLICT DO UPDATE โดยไม่ DELETE ก่อน
   * SKU ที่มีเฉพาะสาขาแรกจึงค้างอยู่ ยอดตั้งต้นกลายเป็น A ∪ B
   */
  it(
    'เปลี่ยนสาขาแล้วถ่ายใหม่ ต้องไม่เหลือ SKU ของสาขาเดิม',
    async () => {
      if (branchA === branchB) {
        // DB นี้มีสาขาเดียว — ข้ามแทนที่จะให้ผ่านแบบหลอก ๆ
        console.warn('ข้าม: public.stock มีสาขาเดียว ทดสอบการปนข้ามสาขาไม่ได้');
        return;
      }

      // รอบอ้างอิง: สาขา B ล้วน ๆ ไม่เคยผ่านสาขาอื่นมาก่อน
      const reference = await newSession();
      const refResult = await snapshotExpected(reference.id, branchB);
      const skusOfBOnly = await expectedSkus(reference.id);

      // รอบที่สลับสาขา: A ก่อน แล้วทับด้วย B
      const switched = await newSession();
      await snapshotExpected(switched.id, branchA);
      const skusA = await expectedSkus(switched.id);
      const switchedResult = await snapshotExpected(switched.id, branchB);
      const skusAfterSwitch = await expectedSkus(switched.id);

      // เทสนี้จะมีความหมายก็ต่อเมื่อสองสาขามี SKU ไม่เหมือนกัน
      const onlyInA = [...skusA].filter((sku) => !skusOfBOnly.has(sku));
      expect(onlyInA.length).toBeGreaterThan(0);

      // ข้อชี้ขาด: รอบที่สลับสาขาต้องเหมือนรอบที่ถ่ายสาขา B ล้วน ทุกประการ
      const ghosts = [...skusAfterSwitch].filter((sku) => !skusOfBOnly.has(sku));
      expect(ghosts).toEqual([]);
      expect(skusAfterSwitch.size).toBe(skusOfBOnly.size);
      expect(switchedResult.rows).toBe(refResult.rows);
      expect(await countExpected(switched.id)).toBe(refResult.rows);
    },
    300_000,
  );

  it(
    'สาขาที่ไม่มีอยู่จริง → 0 แถว และล้างของเดิมทิ้ง',
    async () => {
      const session = await newSession();

      await snapshotExpected(session.id, branchA);
      expect(await countExpected(session.id)).toBeGreaterThan(0);

      const result = await snapshotExpected(session.id, '__ไม่มีสาขานี้__');

      expect(result.rows).toBe(0);
      expect(await countExpected(session.id)).toBe(0);
    },
    180_000,
  );
});
