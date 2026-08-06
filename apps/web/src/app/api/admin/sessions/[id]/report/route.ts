/**
 * GET /api/admin/sessions/[id]/report — ตารางผลต่างทั้งรอบสำหรับหน้าแอดมิน
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/server/auth';
import { sessionReport, sessionReportDelta } from '@/server/counting/report';
import { badRequest, notFound, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');

  /*
   * อ่าน id จาก URL แทนการรับ params ของ Next
   * เพราะ withApi() ห่อ handler ให้เหลือ signature (req) => Response ตัวเดียว
   */
  const url = new URL(req.url);
  const id = url.pathname.split('/').at(-2)!;
  const sinceRaw = url.searchParams.get('since');

  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) throw badRequest('since ต้องเป็นวันเวลา ISO ที่ถูกต้อง');

    const delta = await sessionReportDelta(id, since);
    if (!delta) throw notFound('ไม่พบรอบนับนี้');

    return NextResponse.json(delta, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-CC-Delta-Rows': String(delta.rows.length),
      },
    });
  }

  const report = await sessionReport(id);
  if (!report) throw notFound('ไม่พบรอบนับนี้');

  return NextResponse.json(report, { headers: { 'Cache-Control': 'private, no-store' } });
});
