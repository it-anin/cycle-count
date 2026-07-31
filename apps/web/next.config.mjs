import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/*
 * Next.js โหลด .env จากโฟลเดอร์ของแอป (apps/web) เท่านั้น ไม่มองขึ้นไปที่ root ของ monorepo
 * แต่ .env ของโปรเจกต์นี้อยู่ที่ root ตัวเดียว ใช้ร่วมกับ drizzle/seed/สคริปต์อัปโหลด
 * จึงต้องโหลดเองที่นี่ ไม่งั้น DATABASE_URL กับ Supabase key จะเป็น undefined ตอนรัน
 */
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  // บน Vercel ตั้ง env ผ่าน dashboard อยู่แล้ว ไม่มีไฟล์ .env
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ให้ Next transpile โค้ดจาก workspace packages (ไม่ได้ pre-build)
  transpilePackages: ['@cycle-count/core', '@cycle-count/db'],
  experimental: {
    // อนุญาต import จากนอก dir ของ app (monorepo)
    externalDir: true,
  },
};

export default nextConfig;
