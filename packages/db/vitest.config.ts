import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
     * ยังไม่มีไฟล์เทสในแพ็กเกจนี้ — ค่าเริ่มต้นของ vitest คือ exit 1 ซึ่งจะทำให้ CI แดง
     * เปิดไว้ก่อนจนกว่าจะเพิ่มเทสของ splitCsvLine() กับ numeric() (ขั้น 0.7 ในแผน)
     * ตอนนั้นค่อยลบบรรทัดนี้ทิ้ง จะได้กลับมาจับกรณีที่เทสหายไปทั้งแพ็กเกจ
     */
    passWithNoTests: true,
  },
});
