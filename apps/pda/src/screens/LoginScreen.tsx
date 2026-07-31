/**
 * หน้าล็อกอินของ PDA — รหัสพนักงาน + PIN
 *
 * ไม่ใช้อีเมล/รหัสผ่านเพราะพิมพ์บนจอ 480px ลำบากและพนักงานคลังส่วนใหญ่ไม่มีอีเมลบริษัท
 * ฝั่งหลังบ้าน authEmailForEmployee() แปลงรหัสพนักงานเป็นอีเมลสังเคราะห์ให้ Supabase Auth
 *
 * รหัสพนักงานมีตัวอักษรได้ (EMP-2041) จึงใช้คีย์บอร์ดปกติ — พิมพ์แค่ครั้งเดียวต่อกะ
 * ส่วน PIN ใช้คีย์แพดของแอปเพื่อไม่ให้คีย์บอร์ดเด้งมาบัง และกดด้วยถุงมือได้
 */
import { useState } from 'react';

import { authEmailForEmployee } from '@cycle-count/core';

import { api, usingMock } from '../lib/api';

interface Props {
  onSignedIn: () => void;
}

const PIN_MAX = 8;

/** รหัสที่ยังพิมพ์ไม่ครบอาจไม่มีตัวอักษรเลย ซึ่ง authEmailForEmployee จะ throw */
function safeEmail(code: string): string {
  try {
    return authEmailForEmployee(code);
  } catch {
    return '—';
  }
}

export default function LoginScreen({ onSignedIn }: Props) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = code.trim().length > 0 && pin.length >= 4;

  function pressDigit(digit: string) {
    setError(null);
    setPin((v) => (v + digit).slice(0, PIN_MAX));
  }

  function backspace() {
    setError(null);
    setPin((v) => v.slice(0, -1));
  }

  async function signIn() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.signIn(code.trim(), pin);
      onSignedIn();
    } catch (err) {
      setPin('');
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lg">
      <header className="lg-head">
        <span className="cc-bars cc-bars--lg" aria-hidden="true" />
        <h1 className="lg-title">Cycle Count</h1>
        <p className="lg-sub">ระบบนับสต็อก</p>
      </header>

      <label className="lg-code">
        <span className="cc-k">รหัสพนักงาน</span>
        <input
          className="lg-code__input"
          value={code}
          autoCapitalize="characters"
          autoComplete="username"
          autoCorrect="off"
          spellCheck={false}
          placeholder="EMP-2041"
          enterKeyHint="next"
          onChange={(e) => {
            setError(null);
            setCode(e.target.value);
          }}
        />
        {/* โชว์อีเมลที่รหัสนี้ map ไป — เห็นทันทีว่าพิมพ์รหัสถูกบัญชีหรือเปล่า */}
        {code.trim() && <span className="lg-code__hint">{safeEmail(code)}</span>}
      </label>

      <div className="lg-pin">
        <span className="cc-k">PIN</span>
        <div className="lg-pin__dots" aria-label={`กรอก PIN แล้ว ${pin.length} หลัก`}>
          {Array.from({ length: Math.max(6, pin.length) }, (_, i) => (
            <span key={i} className={`lg-dot ${i < pin.length ? 'lg-dot--on' : ''}`} />
          ))}
        </div>
      </div>

      {error && <p className="lg-error">{error}</p>}

      {usingMock && <p className="lg-dev">โหมดทดสอบ — ยังไม่ได้ตั้งค่า Supabase กรอกอะไรก็ผ่าน</p>}

      <div className="lg-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="cc-key" onClick={() => pressDigit(d)}>
            {d}
          </button>
        ))}
        <button
          type="button"
          className="cc-key cc-key--fn"
          onClick={() => {
            setError(null);
            setPin('');
          }}
        >
          ล้าง
        </button>
        <button type="button" className="cc-key" onClick={() => pressDigit('0')}>
          0
        </button>
        <button type="button" className="cc-key cc-key--fn" onClick={backspace}>
          ⌫
        </button>
      </div>

      <button type="button" className="lg-go" disabled={!ready || busy} onClick={signIn}>
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </button>
    </div>
  );
}
