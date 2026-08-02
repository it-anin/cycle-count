import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // เทส integration ต้องมี DB จริง แยกไปที่ vitest.integration.config.ts
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
  resolve: {
    /*
     * route handler เขียน `import { db } from '@/lib/db'` ตาม path alias ของ tsconfig
     * vitest ไม่ได้อ่าน tsconfig paths ให้เอง ต้องประกาศซ้ำที่นี่
     * ไม่งั้น import ทุกตัวที่ขึ้นต้นด้วย @/ จะ resolve ไม่เจอตอนรันเทส
     */
    alias: {
      '@': resolve(here, 'src'),
    },
  },
});
