import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const webDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(webDir, '../..');

/*
 * Next.js โหลด .env จากโฟลเดอร์ของแอป (apps/web) เท่านั้น ไม่มองขึ้นไปที่ root ของ monorepo
 * แต่ .env ของโปรเจกต์นี้อยู่ที่ root ตัวเดียว ใช้ร่วมกับ drizzle/seed/สคริปต์อัปโหลด
 * จึงต้องโหลดเองที่นี่ ไม่งั้น DATABASE_URL กับ Supabase key จะเป็น undefined ตอนรัน
 */
try {
  process.loadEnvFile(resolve(workspaceRoot, '.env'));
} catch {
  // บน Vercel ตั้ง env ผ่าน dashboard อยู่แล้ว ไม่มีไฟล์ .env
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ล็อก tracing ไว้ที่ monorepo นี้ ไม่ให้ Next เลือก lockfile นอก workspace แล้ว trace กว้างเกินจริง
  outputFileTracingRoot: workspaceRoot,

  // ให้ Next transpile โค้ดจาก workspace packages (ไม่ได้ pre-build)
  transpilePackages: ['@cycle-count/core', '@cycle-count/db'],

  /*
   * ตอน dev เครื่อง PDA กับเบราว์เซอร์ในวงเรียกเข้ามาด้วย IP ไม่ใช่ localhost
   * Next 15 เตือนว่าเวอร์ชันหน้าจะบล็อกการโหลด /_next/* ข้าม origin ถ้าไม่ประกาศไว้
   * ถ้าโดนบล็อกจริงคือ JS ฝั่ง client โหลดไม่ได้ = หน้าเว็บกดอะไรไม่ได้ทั้งหน้า
   * มีผลเฉพาะโหมด dev — production เสิร์ฟจาก origin เดียวกันอยู่แล้ว
   */
  allowedDevOrigins: ['192.168.1.147'],

  experimental: {
    // อนุญาต import จากนอก dir ของ app (monorepo)
    externalDir: true,
  },
};

export default nextConfig;
