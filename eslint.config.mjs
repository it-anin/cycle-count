/**
 * ESLint config เดียวของทั้ง monorepo
 *
 * เป้าหมายหลักของไฟล์นี้ **ไม่ใช่เรื่องสไตล์** (prettier ดูแลอยู่แล้ว) แต่เป็นสองอย่าง:
 *
 *  1. จับ promise ที่ลืม await — โค้ดนี้เขียน DB จำนวนมากแบบต่อกันเป็นชุด
 *     `db.insert(...)` ที่ลืม await จะเงียบสนิทและข้อมูลหายโดยไม่มี error
 *
 *  2. บังคับ dependency boundary ให้เป็นกฎที่เครื่องตรวจได้ ไม่ใช่ข้อตกลงในหัว
 *     ตอนนี้ layer ยังไม่ถูกแยกครบ (ดูแผน Phase 3) แต่กฎที่ตั้งไว้ก่อน
 *     จะกันไม่ให้โครงเพี้ยนไปมากกว่านี้ระหว่างที่ค่อย ๆ ย้าย
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/android/**',
      '**/drizzle/**',
      // Next generate ให้เอง เขียนทับทุกครั้งที่ build
      '**/next-env.d.ts',
      '**/*.config.mjs',
      '**/*.config.ts',
      '**/*.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      /*
       * สองข้อนี้คือเหตุผลที่ต้องเปิด type-aware linting ทั้งที่ช้ากว่า
       * ทุก path ที่เขียน DB ในโปรเจกต์นี้เป็น async — ลืม await หนึ่งที่ = ข้อมูลหายเงียบ ๆ
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /*
       * `async f() { return g(); }` เป็นรูปแบบที่ถูกต้อง — บังคับให้มี await
       * แค่เพิ่ม tick ให้ event loop โดยไม่ได้ทำให้ปลอดภัยขึ้น
       */
      '@typescript-eslint/require-await': 'off',

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],

      // ปิดเสียงที่ไม่คุ้มกับโค้ดชุดนี้ — ผลลัพธ์จาก db.execute() เป็น unknown โดยธรรมชาติ
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /* ── boundary: core ต้องบริสุทธิ์ ────────────────────────────────────────── */
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cycle-count/db', 'drizzle-orm', 'next', 'next/*', 'react', 'react-dom'],
              message:
                'packages/core ต้องเป็นตรรกะบริสุทธิ์ ใช้ได้แค่ zod — ' +
                'สองฝั่ง (web + pda) import ไฟล์นี้ร่วมกัน การดึง db/next/react เข้ามาจะพัง build ของ PDA',
            },
          ],
        },
      ],
    },
  },

  /* ── boundary: PDA ห้ามแตะ DB ────────────────────────────────────────────── */
  {
    files: ['apps/pda/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      /*
       * `onClick={async () => …}` เป็นสำนวนปกติของ React และ handler ในโปรเจกต์นี้
       * จับ error เองอยู่แล้ว (ดู useLedger.submit) — เปิดกฎนี้กับ attribute จะได้แต่เสียงรบกวน
       * ส่วนการเช็ค promise ที่ลืม await ในโค้ดปกติยังเปิดอยู่
       */
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cycle-count/db', '@cycle-count/db/*', 'drizzle-orm', 'postgres'],
              message:
                'PDA คุยกับ server ผ่าน HTTP เท่านั้น การ import schema เข้ามาจะลาก driver ของ Postgres ลงไปในบันเดิล APK',
            },
          ],
        },
      ],
    },
  },

  /* ── boundary: route handler ห้ามเขียน query เอง ─────────────────────────── */
  {
    files: ['apps/web/src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm/**'],
              message:
                'route handler ควรเรียกผ่าน server/* ไม่ใช่ประกอบ query เอง (ดู Phase 3 ในแผน refactor)',
            },
          ],
        },
      ],
    },
  },

  /* ── เทส: ผ่อนกฎที่ขวางการเขียน stub ────────────────────────────────────── */
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
