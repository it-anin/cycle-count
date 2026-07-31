/** GET /api/admin/branches — สาขาที่มีในระบบสต็อก ให้แอดมินเลือกตอนเปิดรอบนับ */
import { NextResponse } from 'next/server';

import { requireRole } from '@/server/auth';
import { withApi } from '@/server/http';
import { listBranches } from '@/server/stock/sync';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');
  return NextResponse.json({ branches: await listBranches() });
});
