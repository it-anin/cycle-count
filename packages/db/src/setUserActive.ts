/**
 * เปิด/ปิดการใช้งานบัญชี
 *
 *   pnpm --filter @cycle-count/db user:active -- --code EMP-901 --off
 *   pnpm --filter @cycle-count/db user:active -- --code EMP-901 --on
 *   pnpm --filter @cycle-count/db user:active -- --list
 *
 * แยกจาก createUser.ts เพราะการปิดบัญชีไม่ควรต้องกรอกชื่อกับ PIN ใหม่
 *
 * ปิดแล้ว requireUser() จะตีกลับ 403 ทุก endpoint — ทั้ง PDA และเว็บ
 * (ดู apps/web/src/server/auth.ts ว่าทำไมต้องเช็คที่นั่นไม่ใช่ที่ RLS)
 *
 * **ไม่ลบข้อมูลที่คนนั้นนับไว้** count_lines.counted_by เก็บเป็น uuid เปล่า ๆ
 * ไม่มี FK ไป profiles จึงไม่มี cascade — รายงานเก่ายังอ่านได้ครบ
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
const { profiles } = await import('./schema');
const { eq } = await import('drizzle-orm');

const { values } = parseArgs({
  options: {
    code: { type: 'string' },
    on: { type: 'boolean', default: false },
    off: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!dbUrl) throw new Error('ต้องตั้ง DIRECT_URL หรือ DATABASE_URL');

const db = createDb(dbUrl);

async function list() {
  const rows = await db.select().from(profiles).orderBy(profiles.employeeCode);
  console.log('รหัส        ชื่อ                     สิทธิ์     สถานะ');
  console.log('─'.repeat(62));
  for (const p of rows) {
    console.log(
      `${p.employeeCode.padEnd(11)} ${p.name.padEnd(24)} ${p.role.padEnd(9)} ${p.active ? 'ใช้งานได้' : '✕ ปิดแล้ว'}`,
    );
  }
}

if (values.list || (!values.code && !values.on && !values.off)) {
  await list();
  process.exit(0);
}

const code = values.code?.trim();
if (!code) throw new Error('ต้องระบุ --code');
if (values.on === values.off) throw new Error('ต้องเลือกอย่างใดอย่างหนึ่ง: --on หรือ --off');

const active = values.on;

const [before] = await db.select().from(profiles).where(eq(profiles.employeeCode, code)).limit(1);
if (!before) throw new Error(`ไม่พบบัญชีรหัส ${code}`);

if (before.active === active) {
  console.log(`${code} (${before.name}) เป็น ${active ? 'ใช้งานได้' : 'ปิดแล้ว'} อยู่แล้ว ไม่ต้องแก้`);
  process.exit(0);
}

await db.update(profiles).set({ active }).where(eq(profiles.employeeCode, code));
console.log(`${code} (${before.name}) → ${active ? 'เปิดใช้งาน' : 'ปิดใช้งาน'} เรียบร้อย`);

if (!active) {
  console.log('  บัญชีนี้จะถูกตีกลับ 403 ทุก endpoint ตั้งแต่คำขอถัดไป');
  console.log('  ข้อมูลที่นับไว้แล้วยังอยู่ครบ ไม่ได้ถูกลบ');
}

console.log('');
await list();
process.exit(0);
