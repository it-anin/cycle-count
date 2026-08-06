/**
 * ลำดับการเปิดแอป PDA
 *   1. เช็คว่ามี session ค้างอยู่ไหม (supabase-js เก็บและต่ออายุให้เอง)
 *   2. ยังไม่ล็อกอิน → หน้าล็อกอิน
 *   3. โหลด catalog ของรอบนับลงเครื่อง
 *   4. หน้าจอนับสต็อก
 *
 * catalog ต้องพร้อมก่อนเข้าหน้านับ เพราะ lookup() ในหน้านั้นเป็น sync ไม่มีสถานะ "กำลังค้น"
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type CatalogStatus, type CurrentUser, type SessionInfo } from './lib/api';
import CountLedgerScreen from './screens/CountLedgerScreen';
import LoginScreen from './screens/LoginScreen';

type Boot =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'loading'; step: string }
  | { kind: 'ready'; user: CurrentUser; session: SessionInfo; catalog: CatalogStatus }
  | { kind: 'error'; message: string };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'checking' });

  const start = useCallback(async () => {
    try {
      if (!(await api.currentSessionToken())) {
        setBoot({ kind: 'signed-out' });
        return;
      }

      setBoot({ kind: 'loading', step: 'กำลังเปิดรอบนับ…' });
      const { user, session } = await api.bootstrap();

      setBoot({ kind: 'loading', step: 'กำลังโหลดรายการสินค้า…' });
      const catalog = await api.loadCatalog(session.id);

      setBoot({ kind: 'ready', user, session, catalog });
    } catch (err) {
      setBoot({
        kind: 'error',
        message: err instanceof Error ? err.message : 'เชื่อมต่อไม่ได้',
      });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  switch (boot.kind) {
    case 'checking':
      return <div className="cc-boot">กำลังตรวจสอบสิทธิ์…</div>;

    case 'signed-out':
      return <LoginScreen onSignedIn={() => void start()} />;

    case 'loading':
      return <div className="cc-boot">{boot.step}</div>;

    case 'error':
      return (
        <div className="cc-boot cc-boot--error">
          <p>เปิดรอบนับไม่ได้</p>
          <p className="cc-boot__detail">{boot.message}</p>
          <button type="button" onClick={() => void start()}>
            ลองใหม่
          </button>
          <button
            type="button"
            className="cc-boot__alt"
            onClick={async () => {
              await api.signOut();
              setBoot({ kind: 'signed-out' });
            }}
          >
            ออกจากระบบ
          </button>
        </div>
      );

    case 'ready':
      return (
        <CountLedgerScreen
          user={boot.user}
          session={boot.session}
          catalogCount={boot.catalog.entryCount}
          catalogVersion={boot.catalog.catalogVersion}
          onSignOut={async () => {
            await api.signOut();
            setBoot({ kind: 'signed-out' });
          }}
        />
      );
  }
}
