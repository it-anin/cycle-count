import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** health check — ยืนยันว่า API route ทำงานและอ่าน env ได้ */
export function GET() {
  const hasDb = Boolean(process.env.DATABASE_URL);
  const hasSupabase = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  return NextResponse.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: { database: hasDb, supabase: hasSupabase },
  });
}
