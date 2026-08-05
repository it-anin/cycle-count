/**
 * GET /api/admin/sessions/[id]/export — ส่งออกผลต่างเป็นไฟล์ Excel
 *
 * ใช้ xlsx ที่มีอยู่แล้วใน dependency ของ apps/web (ตัวเดียวกับที่อ่านไฟล์ import)
 * สร้างในหน่วยความจำแล้วส่งกลับเป็น attachment ไม่ต้องผ่าน Storage
 * เพราะไฟล์รายงานหมื่นแถวยังไม่ถึง 1 MB และไม่ต้องเก็บไว้
 */
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

import { requireRole } from '@/server/auth';
import { sessionReport } from '@/server/counting/report';
import { notFound, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

const KIND_LABEL: Record<string, string> = {
  match: 'ตรง',
  short: 'ขาด',
  over: 'เกิน',
  unknown: 'ต้องตรวจ',
};

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');

  const id = new URL(req.url).pathname.split('/').at(-2)!;

  const report = await sessionReport(id);
  if (!report) throw notFound('ไม่พบรอบนับนี้');

  const { session, totals, rows, counterStats } = report;

  /*
   * แถวหัวเรื่องด้านบนก่อนตาราง — ผู้ตรวจสอบบัญชีต้องเห็นว่ายอดนี้คือ ณ เวลาไหน
   * ไม่งั้นไฟล์ที่หลุดออกไปจะไม่มีทางรู้ว่าเทียบกับ cut-off ไหน
   */
  const head = [
    ['รายงานผลต่างการนับสต็อก'],
    ['รหัสรอบ', session.code],
    ['ชื่อรอบ', session.name],
    ['สาขา', session.sourceBranch ?? session.location ?? '—'],
    ['โหมด', session.mode === 'blind' ? 'ปิดยอด (blind)' : 'รอบทวน (recount)'],
    ['วันที่ตัดยอด', session.snapshotAt ? new Date(session.snapshotAt).toLocaleString('th-TH') : '—'],
    ['สถานะ', session.status === 'closed' ? 'ปิดแล้ว' : session.status === 'active' ? 'กำลังนับ' : 'ร่าง'],
    ['ส่งออกเมื่อ', new Date().toLocaleString('th-TH')],
    [],
    ['สรุป', `ตรง ${totals.match}`, `ขาด ${totals.short}`, `เกิน ${totals.over}`, `ต้องตรวจ ${totals.unknown}`],
    [],
  ];

  const header = [
    'SKU', 'ชื่อสินค้า', 'ตำแหน่ง', 'หน่วยฐาน',
    'ยอดตั้งต้น', 'นับได้', 'ผลต่าง', 'สถานะ', 'ผู้นับ', 'เวลานับล่าสุด',
  ];

  /** r.counters เก็บเป็นรหัสพนักงาน (ตัวระบุที่นิ่งกว่า) — ตารางในไฟล์นี้โชว์เป็นชื่อแทน */
  const nameByCode = new Map(counterStats.map((c) => [c.employeeCode, c.name]));

  const body = rows.map((r) => [
    r.sku ?? '',
    r.name,
    r.location ?? '',
    r.baseUom,
    r.expectedBaseQty ?? '',
    r.countedBaseQty,
    r.diff ?? '',
    KIND_LABEL[r.kind] ?? r.kind,
    r.counters.map((code) => nameByCode.get(code) ?? code).join(', '),
    r.lastCountedAt ? new Date(r.lastCountedAt).toLocaleString('th-TH') : '',
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([...head, header, ...body]);
  sheet['!cols'] = [
    { wch: 12 }, { wch: 38 }, { wch: 12 }, { wch: 10 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 20 }, { wch: 20 },
  ];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'ผลต่าง');

  /*
   * ชีตสรุปรายคน — หัวหน้าใช้ดูว่าใครทำไปเท่าไรโดยไม่ต้องเปิดเว็บ
   *
   * ตั้งใจไม่มีคอลัมน์ "ผิดกี่ตัว" เพราะผลต่างเป็นของ SKU ไม่ใช่ของคน
   * ถ้าสองคนนับ SKU เดียวกัน ผลต่างที่ออกมาเป็นของทั้งคู่รวมกัน โยนให้ใครคนหนึ่งไม่ได้
   */
  if (counterStats.length > 0) {
    const perPerson = XLSX.utils.aoa_to_sheet([
      ['สรุปรายคน', session.code],
      [],
      ['รหัส', 'ชื่อ', 'จำนวน SKU', 'จำนวนบรรทัด', 'รวมหน่วยฐาน', 'นับล่าสุด'],
      ...counterStats.map((c) => [
        c.employeeCode,
        c.name,
        c.skus,
        c.lines,
        c.baseQty,
        c.lastCountedAt ? new Date(c.lastCountedAt).toLocaleString('th-TH') : '',
      ]),
      [],
      [
        'รวมทั้งรอบ',
        '',
        totals.counted,
        counterStats.reduce((s, c) => s + c.lines, 0),
        counterStats.reduce((s, c) => s + c.baseQty, 0),
        '',
      ],
      [
        '',
        'ช่อง SKU รวมนับแบบไม่ซ้ำ ถ้าสองคนนับตัวเดียวกันจะน้อยกว่าผลบวกรายคน',
      ],
    ]);
    perPerson['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(book, perPerson, 'สรุปรายคน');
  }

  const buffer: Buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // ชื่อไฟล์เป็น ASCII ล้วน — ชื่อไทยใน Content-Disposition ทำให้บาง browser เพี้ยน
      'Content-Disposition': `attachment; filename="cycle-count-${session.code}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});
