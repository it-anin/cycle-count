import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit ไม่โหลด .env ให้เอง ต่างจาก seed/upload ที่โหลดเองอยู่แล้ว
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  // ไม่มี .env ก็ใช้ env ที่ export ไว้แล้ว
}

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error('DIRECT_URL or DATABASE_URL must be set to run drizzle-kit');
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  /**
   * จำกัดให้จัดการเฉพาะ schema ของเราเท่านั้น
   *
   * โปรเจกต์ Supabase นี้ใช้ร่วมกับระบบอื่นที่มีข้อมูล production อยู่ใน `public`
   * ถ้าเผลอปล่อยให้ drizzle-kit เห็น public มันจะ generate migration
   * ที่ DROP ตารางของระบบอื่นทิ้ง เพราะไม่มีอยู่ใน schema.ts ของเรา
   */
  schemaFilter: ['cycle_count'],
  verbose: true,
  strict: true,
});
