export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">Cycle Count — Admin</h1>
      <p className="mt-2 text-slate-500">ระบบนับสต็อก · หน้าจัดการสำหรับแอดมิน</p>

      <div className="mt-8 rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="font-semibold">สถานะ: Phase 0 — Setup ✔</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-400">
          <li>โครง monorepo + Drizzle schema พร้อม</li>
          <li>Pricing resolver + unit tests พร้อม</li>
          <li>ถัดไป (Phase 1): auth + หน้าอัปโหลด Excel + column mapping</li>
        </ul>
      </div>

      <p className="mt-6 text-sm text-slate-500">
        ตรวจสุขภาพระบบ:{' '}
        <a className="text-blue-600 underline" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
