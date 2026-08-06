export default function Loading() {
  return (
    <main className="flex h-dvh flex-col bg-white text-slate-900">
      <div className="h-11 animate-pulse border-b border-slate-300 bg-slate-100" />
      <div className="h-9 animate-pulse border-b border-slate-200 bg-white" />
      <div className="flex-1 space-y-px overflow-hidden p-3">
        {Array.from({ length: 14 }, (_, index) => (
          <div
            key={index}
            className="h-7 animate-pulse bg-slate-100"
            style={{ opacity: 1 - index * 0.045 }}
          />
        ))}
      </div>
      <p className="sr-only">กำลังโหลดรายงานรอบนับ…</p>
    </main>
  );
}
