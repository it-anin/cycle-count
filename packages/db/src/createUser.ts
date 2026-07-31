/**
 * สร้างผู้ใช้สำหรับระบบนับสต็อก
 *
 *   pnpm --filter @cycle-count/db create:user -- --code EMP-001 --name "สมชาย ป." \
 *        --pin 246810 --warehouse "คลังสินค้า" --role counter
 *
 * ทำสองอย่างที่ต้องคู่กันเสมอ:
 *   1. สร้าง user ใน Supabase Auth (ผ่าน admin API ด้วย service_role key)
 *   2. เพิ่มแถวใน cycle_count.profiles (ผ่าน Postgres ตรง เพราะ PostgREST ไม่เปิด schema นี้)
 *
 * ถ้ามีแค่ข้อ 1 จะล็อกอินผ่านแต่ requireUser() ตีกลับ 403 ว่า "ยังไม่ถูกตั้งค่า"
 *
 * อีเมลมาจาก authEmailForEmployee() ตัวเดียวกับที่หน้าล็อกอิน PDA ใช้ —
 * ห้ามคำนวณเองที่นี่ ไม่งั้นรหัสที่สร้างกับรหัสที่ล็อกอินจะ map คนละบัญชี
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

const { authEmailForEmployee } = await import('@cycle-count/core');
const { createClient } = await import('@supabase/supabase-js');
const { createDb } = await import('./client');
const { profiles } = await import('./schema');
const { sql } = await import('drizzle-orm');

const { values } = parseArgs({
  options: {
    code: { type: 'string' },
    name: { type: 'string' },
    pin: { type: 'string' },
    warehouse: { type: 'string' },
    role: { type: 'string', default: 'counter' },
  },
});

const code = values.code?.trim();
const name = values.name?.trim();
const pin = values.pin?.trim();
const warehouse = values.warehouse?.trim() ?? null;
const role = values.role === 'admin' ? 'admin' : 'counter';

if (!code || !name || !pin) {
  throw new Error('ต้องระบุ --code, --name และ --pin');
}
// Supabase Auth บังคับรหัสผ่านอย่างน้อย 6 ตัว
if (pin.length < 6) throw new Error('PIN ต้องยาวอย่างน้อย 6 หลัก (ข้อกำหนดของ Supabase Auth)');

const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

if (!dbUrl) throw new Error('ต้องตั้ง DIRECT_URL');
if (!supabaseUrl || !serviceKey) {
  throw new Error('ต้องตั้ง NEXT_PUBLIC_SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY (หรือ SUPABASE_SERVICE_KEY)');
}

const email = authEmailForEmployee(code);
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`รหัสพนักงาน ${code} → อีเมล ${email}`);

/** หา user เดิมก่อน เพื่อให้รันซ้ำแล้วเป็นการอัปเดต PIN ไม่ใช่ error */
async function findExisting(): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`อ่านรายชื่อผู้ใช้ไม่ได้: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

const existingId = await findExisting();
let userId: string;

if (existingId) {
  const { error } = await admin.auth.admin.updateUserById(existingId, { password: pin });
  if (error) throw new Error(`อัปเดต PIN ไม่สำเร็จ: ${error.message}`);
  userId = existingId;
  console.log('  มีบัญชีอยู่แล้ว — อัปเดต PIN ให้');
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: pin,
    // ยืนยันให้เลย ไม่งั้น Supabase จะพยายามส่งอีเมลไปโดเมนที่ไม่มี MX
    email_confirm: true,
    user_metadata: { employee_code: code, name },
  });
  if (error) throw new Error(`สร้างบัญชีไม่สำเร็จ: ${error.message}`);
  userId = data.user.id;
  console.log('  สร้างบัญชีใหม่แล้ว');
}

const db = createDb(dbUrl);
await db
  .insert(profiles)
  .values({ userId, name, employeeCode: code, warehouse, role, active: true })
  .onConflictDoUpdate({
    target: profiles.userId,
    set: {
      name: sql`excluded.name`,
      employeeCode: sql`excluded.employee_code`,
      warehouse: sql`excluded.warehouse`,
      role: sql`excluded.role`,
      active: sql`excluded.active`,
    },
  });

console.log(`  profile: ${name} · ${role}${warehouse ? ` · ${warehouse}` : ''}`);
console.log('เสร็จสิ้น ✔');
process.exit(0);
