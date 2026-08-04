/**
 * GET /api/admin/sessions/[id]/report — ตารางผลต่างทั้งรอบสำหรับหน้าแอดมิน
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/server/auth';
import { sessionReport } from '@/server/counting/report';
import { notFound, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');

  /*
   * อ่าน id จาก URL แทนการรับ params ของ Next
   * เพราะ withApi() ห่อ handler ให้เหลือ signature (req) => Response ตัวเดียว
   */
  const id = new URL(req.url).pathname.split('/').at(-2)!;

  const report = await sessionReport(id);
  if (!report) throw notFound('ไม่พบรอบนับนี้');

  return NextResponse.json(report);
});
