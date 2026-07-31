import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client ที่ใช้ service role — ข้าม RLS ได้ทั้งหมด
 * ใช้เฉพาะฝั่ง server และเฉพาะงานที่ต้องการจริง ๆ (ตอนนี้คือ Storage ของไฟล์ import)
 * ห้าม import เข้า client component เด็ดขาด
 */
let cached: SupabaseClient | undefined;

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // SUPABASE_SERVICE_KEY คือชื่อที่สคริปต์เดิมของทีมใช้อยู่ — รับทั้งสองชื่อจะได้ใช้ .env ร่วมกันได้
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'ต้องตั้ง NEXT_PUBLIC_SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY (หรือ SUPABASE_SERVICE_KEY)',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** bucket เก็บไฟล์ Excel ที่แอดมินอัปโหลด (ต้องสร้างใน Supabase Storage และตั้งเป็น private) */
export const IMPORT_BUCKET = 'imports';
