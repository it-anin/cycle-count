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
import { setLogUser } from './logging';

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

async function userIdFromCookies(): Promise<string | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * คืนผู้ใช้ที่ล็อกอินอยู่ พร้อม profile
 * โยน 401 ถ้าไม่ได้ล็อกอิน หรือล็อกอินแล้วแต่ยังไม่มีแถวใน profiles
 */
export async function requireUser(req: Request): Promise<AuthContext> {
  const token = bearerToken(req);
  const userId = token ? await userIdFromToken(token) : await userIdFromCookies();

  if (!userId) throw unauthorized();

  // ผูก userId เข้ากับ log ของคำขอนี้ — ทำทันทีที่รู้ตัวตน ก่อนเช็ค profile
  // เพื่อให้เคส "ล็อกอินผ่านแต่ยังไม่มี profile" ตามตัวได้ว่าเป็นใคร
  setLogUser(userId);

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);

  // ล็อกอินผ่านแต่ยังไม่มี profile = แอดมินยังไม่ได้ตั้งค่าให้คนนี้
  if (!profile) throw forbidden('บัญชีนี้ยังไม่ถูกตั้งค่าให้ใช้งานระบบนับสต็อก');

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
