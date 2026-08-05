/**
 * ตารางผลต่างเต็มจอ — แบบที่ 8 จาก design/admin-layouts.html
 *
 * เจตนาของแบบนี้คือ **ความหนาแน่น** งานหลักของแอดมินคือกวาดตาหาตัวที่ผิด
 * ในรายการเป็นร้อย ไม่ใช่อ่านทีละใบ ทุกอย่างจึงถูกบีบให้เห็นได้มากแถวที่สุดต่อจอ
 * อย่าเพิ่ม padding หรือการ์ดครอบโดยไม่จำเป็น มันจะทำลายเหตุผลที่เลือกแบบนี้
 *
 * แถบบน = ระดับ "ทั้งรอบนับ" (ส่งออก / ปิดรอบ)
 * แถบล่าง = ระดับ "ตาราง" (กรอง / ค้นหา) — แยกกันไว้ให้ชัด
 */
'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import NewSessionDialog from './NewSessionDialog';

type Kind = 'match' | 'short' | 'over' | 'unknown';

interface Row {
  sku: string | null;
  name: string;
  location: string | null;
  baseUom: string;
  expectedBaseQty: number | null;
  countedBaseQty: number;
  diff: number | null;
  kind: Kind;
  counters: string[];
  lastCountedAt: string | null;
}

interface CounterStat {
  employeeCode: string;
  name: string;
  skus: number;
  lines: number;
  baseQty: number;
  lastCountedAt: string | null;
}

interface Report {
  session: {
    id: string;
    code: string;
    name: string;
    mode: 'blind' | 'recount';
    status: 'draft' | 'active' | 'closed';
    sourceBranch: string | null;
    snapshotAt: string | null;
  };
  totals: { match: number; short: number; over: number; unknown: number; counted: number; expectedSkus: number };
  counterStats: CounterStat[];
  rows: Row[];
}

const num = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 4 });

function time(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

const FILTERS: { key: Kind | 'all'; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'short', label: 'ขาด' },
  { key: 'over', label: 'เกิน' },
  { key: 'unknown', label: 'ต้องตรวจ' },
  { key: 'match', label: 'ตรง' },
];

export default function SessionTable({ report }: { report: Report }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  const { session, totals } = report;
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  /** null = ทุกคน — เก็บเป็นรหัสพนักงานเพราะ ReportRow.counters เก็บรหัสไว้อยู่แล้ว */
  const [who, setWho] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [closing, setClosing] = useState(false);
  const [confirm, setConfirm] = useState<{ message: string } | null>(null);
  const [closed, setClosed] = useState(session.status === 'closed');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return report.rows.filter((r) => {
      if (filter !== 'all' && r.kind !== filter) return false;
      if (who && !r.counters.includes(who)) return false;
      if (!needle) return true;
      return (
        (r.sku ?? '').toLowerCase().includes(needle) ||
        r.name.toLowerCase().includes(needle) ||
        (r.location ?? '').toLowerCase().includes(needle)
      );
    });
  }, [report.rows, filter, who, q]);

  /*
   * ตัวเลขบนชิปกรองต้องขยับตามคนที่เลือกด้วย
   * ไม่งั้นกดกรองเฉพาะ "มุก" แล้วชิปยังขึ้น "ขาด 14" ทั้งที่ในตารางเหลือ 3 แถว
   */
  const count: Record<Kind | 'all', number> = useMemo(() => {
    if (!who) {
      return {
        all: totals.counted,
        match: totals.match,
        short: totals.short,
        over: totals.over,
        unknown: totals.unknown,
      };
    }
    const mine = report.rows.filter((r) => r.counters.includes(who));
    return {
      all: mine.length,
      match: mine.filter((r) => r.kind === 'match').length,
      short: mine.filter((r) => r.kind === 'short').length,
      over: mine.filter((r) => r.kind === 'over').length,
      unknown: mine.filter((r) => r.kind === 'unknown').length,
    };
  }, [report.rows, who, totals]);

  async function close(force: boolean) {
    setClosing(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sessions/${session.id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();

      if (res.status === 409 && data.needsConfirm) {
        setConfirm({ message: data.message });
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'ปิดรอบไม่สำเร็จ');
        return;
      }

      setConfirm(null);
      setClosed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ปิดรอบไม่สำเร็จ');
    } finally {
      setClosing(false);
    }
  }

  /*
   * ตารางแสดง "ผู้นับ" เป็นชื่อ แต่การกรอง (who) ยังอ้างด้วยรหัสเหมือนเดิม
   * รหัสเป็นตัวระบุที่นิ่งกว่าเอาไว้ผูก state ส่วนชื่อไว้ให้คนอ่านเท่านั้น
   */
  const nameByCode = useMemo(
    () => new Map(report.counterStats.map((c) => [c.employeeCode, c.name])),
    [report.counterStats],
  );

  const diffClass = (kind: Kind) =>
    kind === 'short' ? 'text-red-700' : kind === 'over' ? 'text-blue-700' : kind === 'unknown' ? 'text-amber-700' : 'text-emerald-700';

  return (
    <div className="flex h-dvh flex-col bg-white text-[13px] text-slate-900">
      {/* ── แถบบน: ระดับทั้งรอบนับ ─────────────────────────── */}
      <header className="flex h-11 flex-none items-center gap-4 border-b border-slate-300 bg-slate-100 px-3">
        <b className="text-[13px]">{session.code}</b>
        <span className="text-slate-500">{session.sourceBranch ?? '—'}</span>
        <span className="text-slate-500">{session.mode === 'blind' ? 'ปิดยอด' : 'รอบทวน'}</span>
        <span className={closed ? 'text-slate-500' : 'font-semibold text-emerald-700'}>
          {closed ? 'ปิดแล้ว' : 'กำลังนับ'}
        </span>
        <span className="text-slate-500">
          {num(totals.counted)} / {num(totals.expectedSkus)} SKU
        </span>

        <div className="ml-auto flex gap-2">
          {/*
            หน้านี้เป็น Server Component ธรรมดา ไม่มี polling/websocket ตั้งใจ —
            ข้อมูลจึงนิ่งอยู่ ณ ตอนที่โหลดหน้า สแกนใหม่จาก PDA จะไม่ขึ้นเองจนกว่าจะรีเฟรช
            router.refresh() สั่งให้ Server Component ฝั่งนี้ query DB ใหม่โดยไม่รีโหลดทั้งหน้า
            (state ของตัวกรอง/ค้นหาด้านล่างไม่หายเพราะเป็น client state)
          */}
          <button
            type="button"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
            className="border border-slate-400 bg-white px-3 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? 'กำลังโหลด…' : '↻ รีเฟรช'}
          </button>
          <button
            type="button"
            onClick={() => setOpening(true)}
            className="border border-slate-400 bg-white px-3 py-1 text-xs hover:bg-slate-50"
          >
            + เปิดรอบใหม่
          </button>
          <a
            href={`/api/admin/sessions/${session.id}/export`}
            className="border border-slate-400 bg-white px-3 py-1 text-xs hover:bg-slate-50"
          >
            ส่งออก Excel
          </a>
          {!closed && (
            <button
              type="button"
              disabled={closing}
              onClick={() => void close(false)}
              className="border border-red-700 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {closing ? 'กำลังปิด…' : 'ปิดรอบ'}
            </button>
          )}
        </div>
      </header>

      {/* ── แถบล่าง: ระดับตาราง ────────────────────────────── */}
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-slate-200 px-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`border px-2.5 py-0.5 text-xs ${
              filter === f.key
                ? 'border-slate-800 bg-slate-800 text-white'
                : 'border-slate-300 bg-white hover:bg-slate-50'
            }`}
          >
            {f.label} {num(count[f.key])}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหา SKU / ชื่อ / ตำแหน่ง"
          className="ml-auto w-56 border border-slate-300 px-2.5 py-0.5 text-xs outline-none focus:border-slate-800"
        />
      </div>

      {/*
        แถบรายคน — โผล่เฉพาะตอนมีคนนับมากกว่าหนึ่ง
        รอบที่มีคนเดียวแถบนี้ไม่ได้บอกอะไรที่แถบบนไม่ได้บอกอยู่แล้ว และแบบ 8 ที่เลือกไว้
        มีเหตุผลเดียวคือความหนาแน่น — กินที่ฟรีไป 36px ทุกจอไม่คุ้ม
      */}
      {report.counterStats.length > 1 && (
        <div className="flex h-9 flex-none items-center gap-1.5 overflow-x-auto border-b border-slate-200 bg-slate-50 px-3">
          <span className="flex-none text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            ผู้นับ
          </span>
          <button
            type="button"
            onClick={() => setWho(null)}
            className={`flex-none border px-2.5 py-0.5 text-xs ${
              who === null
                ? 'border-slate-800 bg-slate-800 text-white'
                : 'border-slate-300 bg-white hover:bg-slate-100'
            }`}
          >
            ทุกคน
          </button>
          {report.counterStats.map((c) => (
            <button
              key={c.employeeCode}
              type="button"
              onClick={() => setWho(who === c.employeeCode ? null : c.employeeCode)}
              title={`${c.name} (${c.employeeCode}) · ${num(c.lines)} บรรทัด · ${num(c.baseQty)} หน่วยฐาน`}
              className={`flex-none border px-2.5 py-0.5 text-xs whitespace-nowrap ${
                who === c.employeeCode
                  ? 'border-slate-800 bg-slate-800 text-white'
                  : 'border-slate-300 bg-white hover:bg-slate-100'
              }`}
            >
              <b className="font-semibold">{c.name}</b>{' '}
              <span className="font-mono tabular-nums">{num(c.skus)}</span> SKU
              {c.lastCountedAt && (
                <span className={who === c.employeeCode ? 'text-slate-300' : 'text-slate-400'}>
                  {' '}
                  · {time(c.lastCountedAt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="flex-none border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</p>
      )}

      {/* ── ตาราง ──────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['SKU', 'ชื่อสินค้า', 'ตำแหน่ง', 'หน่วยฐาน', 'ตั้งต้น', 'นับได้', 'ผลต่าง', 'ผู้นับ', 'เวลา'].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`sticky top-0 z-10 border-b border-slate-300 bg-slate-50 px-2 py-1 text-[11.5px] font-bold whitespace-nowrap ${
                      i >= 4 && i <= 6 ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-slate-400">
                  ไม่มีรายการที่ตรงกับเงื่อนไข
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sku ?? r.name} className="hover:bg-amber-50">
                  <td className="border-b border-slate-100 px-2 py-1 font-mono text-[12px] whitespace-nowrap">
                    {r.sku ?? '—'}
                  </td>
                  <td className="max-w-[22rem] truncate border-b border-slate-100 px-2 py-1">{r.name}</td>
                  <td className="border-b border-slate-100 px-2 py-1 whitespace-nowrap text-slate-500">
                    {r.location ?? ''}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1 whitespace-nowrap text-slate-500">
                    {r.baseUom}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1 text-right font-mono tabular-nums">
                    {r.expectedBaseQty === null ? '—' : num(r.expectedBaseQty)}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1 text-right font-mono tabular-nums">
                    {num(r.countedBaseQty)}
                  </td>
                  <td
                    className={`border-b border-slate-100 px-2 py-1 text-right font-mono font-bold tabular-nums ${diffClass(r.kind)}`}
                  >
                    {r.diff === null ? '?' : r.diff > 0 ? `+${num(r.diff)}` : num(r.diff)}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1 whitespace-nowrap text-slate-500">
                    {r.counters.map((code) => nameByCode.get(code) ?? code).join(', ')}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1 whitespace-nowrap text-slate-500">
                    {time(r.lastCountedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {opening && <NewSessionDialog onClose={() => setOpening(false)} />}

      {/* ── ยืนยันก่อนปิดรอบ ───────────────────────────────── */}
      {confirm && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md border border-slate-300 bg-white p-6">
            <h2 className="text-base font-bold">ปิดรอบ {session.code} ?</h2>
            <p className="mt-3 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {confirm.message}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              ปิดแล้วเครื่อง PDA จะส่งผลเข้ามาไม่ได้อีก ของที่นับค้างอยู่ในเครื่องจะส่งไม่ได้
              และรอบนี้เปิดใหม่ไม่ได้
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={closing}
                onClick={() => void close(true)}
                className="bg-red-700 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {closing ? 'กำลังปิด…' : 'ยืนยันปิดรอบ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
