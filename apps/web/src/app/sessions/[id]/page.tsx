/**
 * หน้าหลักของแอดมิน — ผลต่างของรอบนับหนึ่งรอบ
 *
 * ดึงข้อมูลฝั่ง server แล้วส่งลงไปให้ตารางเลย ไม่ต้องมีสถานะ loading บนจอ
 * รายงานหมื่นแถวก็ยังเป็น query ไม่กี่ตัว (ดู server/counting/report.ts)
 */
import { redirect } from 'next/navigation';

import { requireRole } from '@/server/auth';
import { sessionReport } from '@/server/counting/report';
import { ApiError } from '@/server/http';

import SessionTable from './SessionTable';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  /*
   * requireRole รับ Request แต่ Server Component ไม่มีให้ — ส่ง Request เปล่าไป
   * ตัวมันจะไม่เจอ Bearer header แล้วถอยไปอ่าน cookie เอง ซึ่งคือทางที่เว็บใช้อยู่แล้ว
   */
  try {
    await requireRole(new Request('http://localhost'), 'admin');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    // 403 = ล็อกอินแล้วแต่ไม่ใช่แอดมิน บอกให้ชัดดีกว่าเด้งกลับไปหน้าล็อกอินวนไปมา
    throw err;
  }

  const report = await sessionReport(id);
  if (!report) {
    return (
      <main className="grid min-h-dvh place-items-center text-slate-500">
        ไม่พบรอบนับนี้
      </main>
    );
  }

  return <SessionTable report={report} />;
}
