import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/*
 * เทส integration ยิงใส่ Postgres จริง จึงแยก config ออกจากชุดปกติ
 * ไม่รวมใน `pnpm test` และไม่รันใน CI (ดูเหตุผลใน src/test/integration.ts)
 *
 * ต้องโหลด .env จาก root เอง — vitest ไม่ได้อ่านให้เหมือน Next/Vite
 * และตัวแปรต้องอยู่ใน process.env ตั้งแต่ก่อน import @/lib/db
 */
process.loadEnvFile?.(resolve(repoRoot, '.env'));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // แตะ DB เดียวกัน รันพร้อมกันจะชนกันเอง
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { '@': resolve(here, 'src') },
  },
});
