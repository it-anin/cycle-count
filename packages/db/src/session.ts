/**
 * จัดการรอบนับ — สร้าง / เปิดใช้ / ดูรายการ
 *
 *   pnpm --filter @cycle-count/db session -- --list
 *   pnpm --filter @cycle-count/db session -- --new --code CC-260804-WH \
 *        --name "นับสต็อกคลังสินค้า ส.ค. 2569" --branch "คลังสินค้า"
 *   pnpm --filter @cycle-count/db session -- --activate --code CC-260804-WH
 *
 * ## ทำไมสร้างเป็น draft ก่อน
 *
 * `/api/pda/session` หยิบรอบที่ **active ล่าสุด** ให้เครื่อง PDA อัตโนมัติ
 * ถ้าสร้างเป็น active เลย เครื่องจะกระโดดเข้ารอบใหม่ทันทีทั้งที่ยังไม่ได้ถ่ายยอดตั้งต้น
 * แล้วทุกอย่างจะกลายเป็น "ไม่มียอดตั้งต้น" ในรายงาน
 *
 * ลำดับที่ถูกคือ  สร้าง draft → POST /api/admin/sessions/prepare → --activate
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  /* ใช้ env ที่ export ไว้แล้ว */
}

const { createDb } = await import('./client');
const { countSessions } = await import('./schema');
const { desc, eq, sql } = await import('drizzle-orm');

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    new: { type: 'boolean', default: false },
    activate: { type: 'boolean', default: false },
    code: { type: 'string' },
    name: { type: 'string' },
    branch: { type: 'string' },
    location: { type: 'string' },
    mode: { type: 'string', default: 'blind' },
  },
});

const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!dbUrl) throw new Error('ต้องตั้ง DIRECT_URL หรือ DATABASE_URL');
const db = createDb(dbUrl);

async function list() {
  const rows = await db
    .select()
    .from(countSessions)
    .orderBy(desc(countSessions.createdAt));

  const counts = (await db.execute(sql`
    SELECT session_id::text AS id, count(*)::int AS n
    FROM cycle_count.count_lines GROUP BY session_id
  `)) as unknown as { id: string; n: number }[];
  const linesOf = new Map(counts.map((c) => [c.id, c.n]));

  console.log('รหัส              สถานะ    โหมด      สาขา          บรรทัดที่นับ  ตัดยอด');
  console.log('─'.repeat(84));
  for (const s of rows) {
    const status = s.status === 'active' ? '● เปิด  ' : s.status === 'closed' ? '  ปิดแล้ว' : '  ร่าง   ';
    const snap = s.snapshotAt ? new Date(s.snapshotAt).toLocaleString('th-TH') : '— ยังไม่ถ่าย';
    console.log(
      `${s.code.padEnd(17)} ${status} ${s.mode.padEnd(9)} ${(s.sourceBranch ?? '—').padEnd(13)} ` +
        `${String(linesOf.get(s.id) ?? 0).padStart(11)}  ${snap}`,
    );
  }
}

if (values.list || (!values.new && !values.activate)) {
  await list();
  process.exit(0);
}

const code = values.code?.trim();
if (!code) throw new Error('ต้องระบุ --code');

if (values.activate) {
  const [s] = await db.select().from(countSessions).where(eq(countSessions.code, code)).limit(1);
  if (!s) throw new Error(`ไม่พบรอบนับรหัส ${code}`);
  if (s.status === 'closed') throw new Error(`${code} ปิดไปแล้ว เปิดใหม่ไม่ได้`);

  if (!s.snapshotAt) {
    throw new Error(
      `${code} ยังไม่ได้ถ่ายยอดตั้งต้น — เปิดใช้ตอนนี้เครื่อง PDA จะนับโดยไม่มียอดให้เทียบ\n` +
        `  ให้เรียก POST /api/admin/sessions/prepare ก่อน`,
    );
  }

  await db.update(countSessions).set({ status: 'active' }).where(eq(countSessions.code, code));
  console.log(`${code} → เปิดใช้งานแล้ว เครื่อง PDA จะหยิบรอบนี้ในการเรียกครั้งถัดไป`);
  console.log('');
  await list();
  process.exit(0);
}

/* ── สร้างรอบใหม่ ─────────────────────────────────────────── */

const name = values.name?.trim();
const branch = values.branch?.trim();
const mode = values.mode === 'recount' ? 'recount' : 'blind';

if (!name) throw new Error('ต้องระบุ --name');
if (!branch) throw new Error('ต้องระบุ --branch (ค่าต้องตรงกับ public.stock.branch)');

const [dup] = await db.select().from(countSessions).where(eq(countSessions.code, code)).limit(1);
if (dup) throw new Error(`รหัส ${code} ถูกใช้ไปแล้ว (สถานะ ${dup.status})`);

const [created] = await db
  .insert(countSessions)
  .values({
    code,
    name,
    mode,
    status: 'draft',
    sourceBranch: branch,
    location: values.location?.trim() ?? branch,
  })
  .returning({ id: countSessions.id });

console.log(`สร้างรอบ ${code} แล้ว (ร่าง)`);
console.log(`  id     ${created!.id}`);
console.log(`  โหมด   ${mode === 'blind' ? 'ปิดยอด — คนนับไม่เห็นยอดระบบ' : 'รอบทวน — เห็นผลต่าง'}`);
console.log(`  สาขา   ${branch}`);
console.log('');
console.log('ขั้นถัดไป — ถ่ายยอดตั้งต้น แล้วค่อยเปิดใช้:');
console.log(`  POST /api/admin/sessions/prepare  { "sessionId": "${created!.id}", "branch": "${branch}" }`);
console.log(`  pnpm --filter @cycle-count/db session -- --activate --code ${code}`);

process.exit(0);
