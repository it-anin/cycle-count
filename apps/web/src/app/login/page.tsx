/**
 * หน้าล็อกอินของเว็บแอดมิน
 *
 * ใช้รหัสพนักงาน + PIN ชุดเดียวกับ PDA — `authEmailForEmployee()` ตัวเดียวกัน
 * ถ้าคำนวณอีเมลเองที่นี่จะ map ไปคนละบัญชีทันทีที่โดเมนเปลี่ยน
 *
 * เข้าได้เฉพาะคนที่ profile.role = 'admin' แต่การตรวจ role อยู่ที่ route handler
 * ที่นี่แค่ล็อกอิน — counter ที่เผลอเข้ามาจะล็อกอินผ่านแต่เรียก API ไม่ได้ (403)
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authEmailForEmployee } from '@cycle-count/core';

import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** รหัสที่ยังพิมพ์ไม่ครบอาจไม่มีตัวอักษรเลย ซึ่ง authEmailForEmployee จะ throw */
  function preview(): string {
    try {
      return authEmailForEmployee(code);
    } catch {
      return '—';
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const email = authEmailForEmployee(code.trim());
      const { error: authError } = await createClient().auth.signInWithPassword({
        email,
        password: pin,
      });

      if (authError) {
        // แยกรหัสผิดออกจากเน็ตมีปัญหา ไม่งั้นไล่หาสาเหตุไม่ถูก
        setError(
          authError.status === 400
            ? 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง'
            : `เชื่อมต่อไม่ได้: ${authError.message}`,
        );
        return;
      }

      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
      <form
        onSubmit={submit}
        className="w-full max-w-sm border border-slate-300 bg-white p-8 dark:border-slate-700 dark:bg-slate-900"
      >
        <h1 className="text-xl font-bold">Cycle Count</h1>
        <p className="mb-7 text-sm text-slate-500">หน้าจัดการสำหรับแอดมิน</p>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
            รหัสพนักงาน
          </span>
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value); setError(null); }}
            autoCapitalize="characters"
            autoComplete="username"
            spellCheck={false}
            placeholder="ADMIN-01"
            className="w-full border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:focus:border-slate-300"
          />
          {code.trim() && (
            <span className="mt-1 block font-mono text-xs text-slate-400">{preview()}</span>
          )}
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
            PIN
          </span>
          <input
            type="password"
            value={pin}
            onChange={(e) => { setPin(e.target.value); setError(null); }}
            autoComplete="current-password"
            className="w-full border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:focus:border-slate-300"
          />
        </label>

        {error && (
          <p className="mb-4 border-l-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !code.trim() || pin.length < 4}
          className="w-full bg-slate-900 py-2.5 text-sm font-semibold text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>
      </form>
    </main>
  );
}
