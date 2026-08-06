/**
 * ตรวจตัวตนและสิทธิ์ฝั่ง server
 *
 * รับได้สองทางเพราะสองแอปคุยคนละแบบ:
 *  - เว็บแอดมิน  → cookie session ผ่าน @supabase/ssr (origin เดียวกัน)
 *  - PDA         → header `Authorization: Bearer <access_token>` (คนละ origin ใช้ cookie ไม่ได้)
 *
 * สำคัญ: Drizzle ต่อ Postgres ตรงด้วย DATABASE_URL ซึ่งเป็น role `postgres`
 * RLS จึงไม่มีผลกับ query ที่ผ่าน Drizzle — การตรวจสิทธิ์จริงต้องเรียกจากที่นี่ทุก route
 * RLS ที่เปิดไว้ใน DB เป็นเกราะชั้นสองสำหรับกรณี anon key หลุดเท่านั้น
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';

import { profiles, type Profile } from '@cycle-count/db';

import { db } from '@/lib/db';
import { createClient as createServerClient } from '@/lib/supabase/server';

import { forbidden, unauthorized } from './http';

export interface AuthContext {
  userId: string;
  profile: Profile;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * ตรวจ access token กับ Supabase Auth (ไม่ decode JWT เอง — ให้ Supabase ยืนยันลายเซ็น)
 *
 * ใช้ anon key เป็นหลักตามหลัก least privilege — สิ่งที่ยืนยันตัวตนคือ token ที่ส่งเข้าไป
 * ไม่ใช่ key ที่ใช้เปิด client ถ้ายังไม่ได้ตั้ง anon key ถอยไปใช้ service role ได้
 * เพราะโค้ดนี้รันฝั่ง server เท่านั้น (ฝั่ง PDA ใช้ service role แทนไม่ได้เด็ดขาด)
 */
async function userIdFromToken(token: string): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error('ต้องตั้ง NEXT_PUBLIC_SUPABASE_URL และ NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  const supabase = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * middleware.ts ตรวจ token ด้วย getClaims() แล้วแปะผลไว้ใน header นี้
 * ถ้ามีให้เชื่อเลยไม่ต้องยิงซ้ำ — เชื่อได้เพราะ middleware ตั้ง/ลบ header นี้เองเสมอ
 * แบบไม่มีเงื่อนไข (ไม่ได้แค่ไม่ลบตอนไม่มี user) จึง client ปลอมค่าเข้ามาเองไม่ได้
 *
 * ไม่มี header (เช่น route ที่ matcher ของ middleware ไม่ครอบ) ก็ยังต้องตรวจ getClaims()
 * ตรงนี้ ไม่ใช่ถือว่าไม่ได้ล็อกอิน — กันเคสที่ลืมอัปเดต matcher ในอนาคต
 */
async function userIdFromCookies(req: Request): Promise<string | null> {
  const trusted = req.headers.get('x-cc-user-id');
  if (trusted) return trusted;

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === 'string' ? data.claims.sub : null;
  return error || !userId ? null : userId;
}

/**
 * คืนผู้ใช้ที่ล็อกอินอยู่ พร้อม profile
 * โยน 401 ถ้าไม่ได้ล็อกอิน หรือล็อกอินแล้วแต่ยังไม่มีแถวใน profiles
 */
export async function requireUser(req: Request): Promise<AuthContext> {
  const token = bearerToken(req);
  const userId = token ? await userIdFromToken(token) : await userIdFromCookies(req);

  if (!userId) throw unauthorized();

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);

  // ล็อกอินผ่านแต่ยังไม่มี profile = แอดมินยังไม่ได้ตั้งค่าให้คนนี้
  if (!profile) throw forbidden('บัญชีนี้ยังไม่ถูกตั้งค่าให้ใช้งานระบบนับสต็อก');

  /*
   * ต้องเช็ค active ที่นี่ ไม่ใช่ที่ RLS
   *
   * RLS มี cycle_count.cc_is_active_user() คุมให้อยู่แล้ว แต่ Drizzle ต่อ DB ด้วย role
   * `postgres` ซึ่ง BYPASSRLS — policy ตัวนั้นจึงไม่เคยทำงานกับ query ที่ผ่านแอปเลย
   * ก่อนมีบรรทัดนี้ ปิดบัญชีแล้วพนักงานยังล็อกอินและส่งผลนับได้ตามปกติ
   *
   * แยกข้อความจาก 'ไม่มีสิทธิ์' ให้ชัด ไม่งั้นเวลาพนักงานโทรมาถามจะไล่สาเหตุไม่ถูก
   */
  if (!profile.active) throw forbidden('บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ');

  return { userId, profile };
}

/** เหมือน requireUser แต่บังคับ role ด้วย */
export async function requireRole(
  req: Request,
  role: Profile['role'],
): Promise<AuthContext> {
  const ctx = await requireUser(req);
  if (ctx.profile.role !== role) throw forbidden();
  return ctx;
}
