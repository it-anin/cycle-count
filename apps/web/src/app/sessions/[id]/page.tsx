/**
 * หน้าหลักของแอดมิน — ผลต่างของรอบนับหนึ่งรอบ
 *
 * ดึงข้อมูลฝั่ง server แล้วส่งลงไปให้ตารางเลย ไม่ต้องมีสถานะ loading บนจอ
 * รายงานหมื่นแถวก็ยังเป็น query ไม่กี่ตัว (ดู server/counting/report.ts)
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { requireRole } from '@/server/auth';
import { ApiError } from '@/server/http';

import SessionView from '../SessionView';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  /*
   * requireRole รับ Request แต่ Server Component ไม่มีให้ — ส่ง header ของ request จริง
   * (มี x-cc-user-id ที่ middleware verify มาแล้ว) ไปด้วย ไม่งั้นมันจะไม่เจอทั้ง header
   * นี้และ Bearer แล้วต้องยิง getUser() ซ้ำเองอีกรอบ
   */
  try {
    await requireRole(new Request('http://localhost', { headers: await headers() }), 'admin');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    // 403 = ล็อกอินแล้วแต่ไม่ใช่แอดมิน บอกให้ชัดดีกว่าเด้งกลับไปหน้าล็อกอินวนไปมา
    throw err;
  }

  return <SessionView id={id} />;
}
