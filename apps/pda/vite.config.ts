import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export default defineConfig(({ command, mode }) => {
  /*
   * Vite โหลด .env จากโฟลเดอร์ของแอป (apps/pda) เท่านั้น ไม่มองขึ้นไปที่ root ของ monorepo
   * แต่ .env ของโปรเจกต์นี้อยู่ที่ root ตัวเดียว ใช้ร่วมกับ Next.js / drizzle / สคริปต์อัปโหลด
   * ถ้าไม่โหลดเอง VITE_* จะเป็น undefined ทั้งหมด แล้วแอปจะตกไปโหมด mock เงียบ ๆ
   *
   * '' = โหลดทุกตัวแปร ไม่กรองด้วย prefix จะได้เห็น NEXT_PUBLIC_* ด้วย
   */
  const env = loadEnv(mode, repoRoot, '');

  /**
   * anon key ตัวเดียวกันใช้ทั้ง Next.js และ PDA — ให้กรอกที่เดียวพอ
   * ถ้าไม่ได้ตั้ง VITE_SUPABASE_ANON_KEY ไว้ ใช้ค่าจาก NEXT_PUBLIC_SUPABASE_ANON_KEY แทน
   */
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const supabaseUrl = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';

  /*
   * ถ้า VITE_API_BASE_URL ว่าง lib/api.ts จะตกไปใช้ mockApi ซึ่ง submit() คืน
   * { saved: n } แล้ว **ทิ้งผลนับทั้งหมด** — APK ที่ build แบบนั้นดูทำงานได้ครบทุกอย่าง
   * พนักงานนับทั้งวัน กดส่ง เห็น "สำเร็จ" แต่ไม่มีอะไรถึง DB สักแถว
   *
   * โหมด mock มีไว้ให้ dev เท่านั้น จึงต้องหยุดที่ build time ไม่ใช่ปล่อยไปเจอตอนรัน
   * (dev server ยังใช้ mock ได้ตามเดิม — เช็กเฉพาะตอน build)
   */
  if (command === 'build' && !env.VITE_API_BASE_URL) {
    throw new Error(
      'ยังไม่ได้ตั้ง VITE_API_BASE_URL — build ต่อจะได้ APK ที่ทิ้งผลนับทั้งหมดเงียบ ๆ\n' +
        `ตั้งค่าใน .env ที่ root ของ monorepo (${repoRoot}) แล้ว build ใหม่\n` +
        'ถ้าตั้งใจจะ build โหมดทดสอบจริง ๆ ให้ระบุ VITE_API_BASE_URL ชี้ไปเครื่อง dev',
    );
  }

  return {
    plugins: [react()],
    /*
     * ค่าพวกนี้ถูกฝังลงบันเดิลตอน build ไม่ได้อ่านตอนรัน
     * เปลี่ยน .env แล้วต้อง build ใหม่เสมอ — APK เก่าจะยังชี้ค่าเดิมตลอดไป
     */
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(anonKey),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL ?? ''),
      'import.meta.env.VITE_MOCK_MODE': JSON.stringify(env.VITE_MOCK_MODE ?? ''),
    },
    server: {
      host: true,
      port: 5173,
    },
    build: {
      outDir: 'dist',
    },
  };
});
