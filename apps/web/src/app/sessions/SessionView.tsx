import { sessionReport } from '@/server/counting/report';

import SessionTable from './[id]/SessionTable';

/** เนื้อหารายงานที่ใช้ร่วมกันระหว่าง `/` และ `/sessions/[id]` โดยไม่ตรวจสิทธิ์ซ้ำ */
export default async function SessionView({ id }: { id: string }) {
  const report = await sessionReport(id);

  if (!report) {
    return <main className="grid min-h-dvh place-items-center text-slate-500">ไม่พบรอบนับนี้</main>;
  }

  return <SessionTable report={report} />;
}
