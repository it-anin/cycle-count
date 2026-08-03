/**
 * จอขาวเป็นอาการที่แย่ที่สุดในคลัง — พนักงานไม่รู้ว่าแอปพัง เครื่องค้าง หรือตัวเองกดผิด
 * และไม่มีอะไรให้กดต่อ
 *
 * โมดูลนี้เปลี่ยน "จอขาวเงียบ ๆ" ให้เป็นข้อความที่อ่านออกและกดลองใหม่ได้
 * โดยไม่พึ่ง React — เพราะ error ที่ทำให้จอขาวมักเกิด**ก่อน**ที่ React จะ mount
 * (เช่น bundle พังตั้งแต่ import แรก หรือ native ยิง event เข้ามาตอน bridge ยังไม่พร้อม)
 *
 * เขียนด้วย DOM API ล้วนและไม่ import อะไรเลย เพื่อให้ทำงานได้แม้ตอนที่ส่วนอื่นพังหมดแล้ว
 */

let shown = false;

/** ค่าที่ reject ออกมาไม่จำเป็นต้องเป็น Error — แปลงให้อ่านได้โดยไม่ได้ '[object Object]' */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'ไม่ทราบสาเหตุ';
  try {
    return JSON.stringify(value) ?? 'ไม่ทราบสาเหตุ';
  } catch {
    return 'ไม่ทราบสาเหตุ';
  }
}

function render(title: string, detail: string): void {
  if (shown) return;
  shown = true;

  const root = document.getElementById('root');
  if (!root) return;

  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'cc-crash';

  const h = document.createElement('p');
  h.className = 'cc-crash__title';
  h.textContent = title;

  const p = document.createElement('p');
  p.className = 'cc-crash__detail';
  p.textContent = detail;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cc-crash__btn';
  btn.textContent = 'เปิดใหม่';
  btn.onclick = () => location.reload();

  const note = document.createElement('p');
  note.className = 'cc-crash__note';
  note.textContent = 'รายการที่นับไว้ยังอยู่ในเครื่อง กดเปิดใหม่แล้วล็อกอินด้วยรหัสเดิมได้เลย';

  wrap.append(h, p, btn, note);
  root.append(wrap);
}

/**
 * ติดตั้งตัวดักทั้งสองทาง — error ที่ throw ตรง ๆ และ promise ที่ reject โดยไม่มีใครรับ
 * เรียกให้เร็วที่สุดใน main.tsx ก่อน import อะไรที่อาจพัง
 */
export function installCrashScreen(): void {
  window.addEventListener('error', (ev) => {
    render('แอปเปิดไม่สำเร็จ', ev.message || 'ไม่ทราบสาเหตุ');
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason: unknown = ev.reason;
    render('แอปเปิดไม่สำเร็จ', describe(reason));
  });

  /*
   * เผื่อกรณีที่ไม่มี error ให้จับแต่ React ก็ไม่ mount (เช่น renderer ถูก freeze
   * ตอนแอปโดน pause แล้วกลับมาไม่ครบ) — ถ้าผ่านไป 10 วินาทีแล้ว #root ยังว่าง
   * ถือว่าเปิดไม่ขึ้น ดีกว่าปล่อยให้ยืนมองจอขาว
   */
  setTimeout(() => {
    const root = document.getElementById('root');
    if (root && root.childElementCount === 0) {
      render('แอปเปิดไม่ขึ้น', 'หน้าจอโหลดไม่เสร็จภายใน 10 วินาที');
    }
  }, 10_000);
}
