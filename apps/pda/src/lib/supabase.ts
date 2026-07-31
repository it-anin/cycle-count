/**
 * Supabase client ของแอป PDA
 *
 * ใช้ supabase-js ตรง ๆ แทนการ proxy auth ผ่าน Next.js เพราะได้ของสำคัญมาฟรี:
 * เก็บ session ต่อเนื่อง และต่ออายุ access token เองก่อนหมดอายุ
 * (กะทิ้งไว้ทั้งกะแล้วโดนเด้งออกกลางรอบนับคือปัญหาจริงบนเครื่อง PDA)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null เมื่อยังไม่ได้ตั้ง env — โหมด mock ไม่ต้องใช้ auth */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // PDA ไม่มี URL callback ให้ parse
          detectSessionInUrl: false,
        },
      })
    : null;

export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
