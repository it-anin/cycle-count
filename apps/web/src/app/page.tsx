/**
 * หน้าแรก — แสดงรอบนับล่าสุดเลย
 *
 * แอดมินเปิดเว็บมาก็เพื่อดูรอบที่กำลังนับอยู่ 99% ของเวลา
 * ให้มีหน้ารายการคั่นกลางเป็นการเพิ่มคลิกโดยไม่ได้อะไร และการ redirect ไป URL
 * รอบล่าสุดทำให้ Auth + query ทำงานซ้ำ จึงใช้ SessionView ร่วมกันแล้วแสดงตรงนี้
 * (รอบเก่าเข้าถึงได้จาก URL ตรง ๆ ไว้ค่อยทำตัวสลับรอบตอนมีหลายคลัง)
 */
import { desc } from 'drizzle-orm';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import SessionView from '@/app/sessions/SessionView';
import { requireRole } from '@/server/auth';
import { ApiError } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export default async function HomePage() {
  try {
    await requireRole(new Request('http://localhost', { headers: await headers() }), 'admin');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    if (err instanceof ApiError && err.status === 403) {
      return (
        <main className="grid min-h-dvh place-items-center px-6 text-center">
          <div>
            <p className="text-lg font-bold">บัญชีนี้ไม่มีสิทธิ์เข้าหน้าแอดมิน</p>
            <p className="mt-1 text-sm text-slate-500">
              ต้องเป็น role admin — ติดต่อผู้ดูแลระบบเพื่อเปลี่ยนสิทธิ์
            </p>
          </div>
        </main>
      );
    }
    throw err;
  }

  const [latest] = await db
    .select({ id: countSessions.id })
    .from(countSessions)
    .orderBy(desc(countSessions.createdAt))
    .limit(1);

  if (!latest) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <div>
          <p className="text-lg font-bold">ยังไม่มีรอบนับ</p>
          <p className="mt-1 text-sm text-slate-500">
            เปิดรอบแรกด้วย <code className="font-mono">POST /api/admin/sessions/prepare</code>
          </p>
        </div>
      </main>
    );
  }

  /*
   * แสดงรอบล่าสุดตรงนี้เลยแทน redirect ไป `/sessions/[id]` เพราะ redirect เดิมทำให้
   * browser เปิด request ใหม่ แล้ว middleware/Auth/profile ต้องทำงานซ้ำทั้งชุด
   * URL รายรอบยังใช้ได้ตามเดิมสำหรับ bookmark และประวัติรอบเก่า
   */
  return <SessionView id={latest.id} />;
}
