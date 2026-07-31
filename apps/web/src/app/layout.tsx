import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Cycle Count — Admin',
  description: 'ระบบนับสต็อก — หน้าจัดการสำหรับแอดมิน',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
