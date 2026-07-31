/** GET /api/pda/session — ใครล็อกอินอยู่ และรอบนับไหนที่เปิดอยู่ */
import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireUser } from '@/server/auth';
import { notFound, preflight, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
// ให้ function รันที่สิงคโปร์ใกล้ DB — ถ้าปล่อย default จะไปรันที่ US แล้วเพิ่ม RTT ต่อ query
export const preferredRegion = 'sin1';

export const OPTIONS = preflight;

export const GET = withApi(async (req) => {
  const { userId, profile } = await requireUser(req);

  // ยังไม่มีหน้าเลือกรอบนับบน PDA — หยิบรอบที่ active ล่าสุดให้เลย
  const [session] = await db
    .select()
    .from(countSessions)
    .where(eq(countSessions.status, 'active'))
    .orderBy(desc(countSessions.createdAt))
    .limit(1);

  if (!session) throw notFound('ยังไม่มีรอบนับที่เปิดอยู่ ให้แอดมินเปิดรอบก่อน');

  return NextResponse.json({
    user: {
      id: userId,
      name: profile.name,
      employeeCode: profile.employeeCode,
      warehouse: profile.warehouse ?? '',
    },
    session: {
      id: session.id,
      code: session.code,
      location: session.location ?? '',
      mode: session.mode,
    },
  });
});
