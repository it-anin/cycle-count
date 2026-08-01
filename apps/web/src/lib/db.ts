import { getDb, type Database } from '@cycle-count/db';

/**
 * Drizzle client สำหรับใช้ใน Route Handlers / Server Actions
 *
 * **สร้างตอนใช้ครั้งแรก ไม่ใช่ตอน import**
 *
 * `next build` จะ import ทุก route module เพื่อเก็บข้อมูลหน้า (collect page data)
 * ถ้าเรียก `getDb()` ที่ระดับ module ตรง ๆ การ build จะพังทันทีเมื่อไม่มี DATABASE_URL
 * ทั้งที่ตอน build ไม่ได้ต่อ DB สักครั้ง — ทำให้ build ใน CI ต้องถือ secret ของ production
 * โดยไม่จำเป็น
 *
 * proxy ตัวนี้เลื่อนการอ่าน env ไปจนถึง query แรกจริง ๆ
 * `getDb()` ยังเป็น singleton เหมือนเดิม จึงได้ pool เดียวต่อ instance ไม่เปลี่ยน
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop) as unknown;
    // bind ให้ method ที่ดึงออกไป (เช่น const { select } = db) ยังมี this ที่ถูกต้อง
    return typeof value === 'function' ? value.bind(real) : value;
  },
});
