/**
 * เปิดรอบนับใหม่
 *
 * กดปุ่มเดียวแล้ว server ทำสามอย่างต่อกัน: สร้างรอบ → ถ่ายยอดตั้งต้น → เปิดใช้
 * ใช้เวลาราว 8-10 วินาทีเพราะต้อง sync catalog หมื่นรายการ จึงต้องมีสถานะกำลังทำให้เห็น
 *
 * **เปิดรอบใหม่ = เครื่อง PDA ทุกเครื่องย้ายไปรอบใหม่ในการเรียกครั้งถัดไป**
 * ถ้ายังมีคนนับค้างอยู่ server จะตอบ 409 มาให้ยืนยันก่อน
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Branch {
  branch: string;
  skuCount: number;
}

/** `CC-260804-WH` — ปีสองหลักแบบ ค.ศ. ให้เรียงตามตัวอักษรแล้วตรงกับลำดับเวลา */
function suggestCode(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `CC-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-WH`;
}

function suggestName(branch: string): string {
  const d = new Date();
  return `นับสต็อก${branch ? ' ' + branch : ''} ${d.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })}`;
}

export default function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();

  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [code, setCode] = useState(suggestCode);
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'blind' | 'recount'>('blind');
  const [closePrevious, setClosePrevious] = useState(true);

  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/admin/branches');
        const data = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(data.error ?? 'อ่านรายชื่อสาขาไม่ได้');
        setBranches(data.branches ?? []);
        const first = data.branches?.[0]?.branch ?? '';
        setBranch(first);
        setName(suggestName(first));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'อ่านรายชื่อสาขาไม่ได้');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function submit(force: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), name: name.trim(), branch, mode, closePrevious, force }),
      });
      const data = await res.json();

      if (res.status === 409 && data.needsConfirm) {
        setConfirm(data.message);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'เปิดรอบไม่สำเร็จ');
        return;
      }

      // refresh ก่อน push เพื่อให้หน้าใหม่ไม่ได้ข้อมูลเก่าจาก router cache
      router.refresh();
      router.push(`/sessions/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เปิดรอบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  const ready = code.trim() && name.trim() && branch && !busy;

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg border border-slate-300 bg-white p-6">
        <h2 className="text-base font-bold">เปิดรอบนับใหม่</h2>
        <p className="mt-1 text-xs text-slate-500">
          สร้างรอบ → ถ่ายยอดตั้งต้นจากระบบสต็อก → เปิดให้เครื่อง PDA ใช้ ใช้เวลาราว 10 วินาที
        </p>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              สาขา
            </span>
            {branches === null ? (
              <div className="border border-slate-200 px-3 py-1.5 text-sm text-slate-400">
                กำลังอ่านรายชื่อสาขา…
              </div>
            ) : (
              <select
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setName(suggestName(e.target.value));
                }}
                className="w-full border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-800"
              >
                {branches.map((b) => (
                  <option key={b.branch} value={b.branch}>
                    {b.branch} — {b.skuCount.toLocaleString('th-TH')} SKU
                  </option>
                ))}
              </select>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                รหัสรอบ
              </span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full border border-slate-300 px-3 py-1.5 font-mono text-sm outline-none focus:border-slate-800"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                ชื่อรอบ
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-800"
              />
            </label>
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              โหมด
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['blind', 'ปิดยอด', 'คนนับไม่เห็นยอดระบบ — ผู้ตรวจสอบบังคับสำหรับรอบแรก'],
                  ['recount', 'รอบทวน', 'เห็นผลต่างทุกแถว ใช้ตอนไปยืนยันตัวที่ผิด'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`border px-3 py-2 text-left text-sm ${
                    mode === value ? 'border-slate-800 ring-1 ring-slate-800' : 'border-slate-300'
                  }`}
                >
                  <b className="block">{mode === value ? '●' : '○'} {label}</b>
                  <span className="text-[11px] leading-tight text-slate-500">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={closePrevious}
              onChange={(e) => setClosePrevious(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              ปิดรอบที่เปิดค้างอยู่ด้วย
              <span className="block text-[11px] text-slate-500">
                ไม่ปิดจะมีสองรอบขึ้นว่าเปิดพร้อมกัน เครื่อง PDA จะใช้รอบใหม่อยู่ดี
              </span>
            </span>
          </label>
        </div>

        {confirm && (
          <p className="mt-4 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {confirm}
            <span className="mt-1 block text-xs">
              เปิดรอบใหม่ตอนนี้ ของที่นับค้างในเครื่องแต่ยังไม่ได้กดส่งจะเข้าไม่ถึงอีก
            </span>
          </p>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void submit(confirm !== null)}
            className={`px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40 ${
              confirm ? 'bg-red-700' : 'bg-slate-900'
            }`}
          >
            {busy ? 'กำลังเปิดรอบ…' : confirm ? 'ยืนยันเปิดรอบใหม่' : 'เปิดรอบ'}
          </button>
        </div>
      </div>
    </div>
  );
}
