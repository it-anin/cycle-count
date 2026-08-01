/**
 * ตัวปลอมของ Drizzle client สำหรับ contract test
 *
 * route handler เรียก query แบบต่อลูกโซ่ (`db.select().from().where().limit()`)
 * แล้ว `await` ตัว builder ตรง ๆ เพราะ builder ของ Drizzle เป็น thenable
 *
 * ตัวปลอมนี้จึงรับ method อะไรก็ได้ คืนตัวเองกลับไปเรื่อย ๆ
 * แล้วตอนถูก await ค่อยดึงผลลัพธ์ตัวถัดไปจากคิวที่ `queueResults()` เตรียมไว้
 *
 * **ลำดับสำคัญ** — ต้องใส่ผลลัพธ์เรียงตามลำดับ query ที่ route ยิงจริง
 * ถ้า route เพิ่ม query ใหม่แล้วลืมเติมคิว เทสจะล้มพร้อมข้อความว่าคิวหมด
 * ซึ่งเป็นสิ่งที่ต้องการ — การเพิ่ม query เข้าไปใน route ที่ PDA เรียกอยู่ต้องมีคนตัดสินใจ
 *
 * `db` เป็น object ตัวเดียวตลอดอายุ process (mock factory ผูกไว้ตอน import)
 * สถานะจึงอยู่ในคิวข้างล่าง ไม่ใช่ในตัว proxy — ทุกเทสต้องเรียก `queueResults()` ใหม่
 */
let queue: unknown[] = [];
let consumed = 0;

/** ตั้งผลลัพธ์ของ query ชุดใหม่ เรียกที่ต้นเทสทุกครั้ง */
export function queueResults(results: unknown[]): void {
  queue = [...results];
  consumed = 0;
}

/** จำนวนผลลัพธ์ที่เตรียมไว้แล้วยังไม่ถูกใช้ — ควรเป็น 0 เมื่อจบเทส */
export function remainingResults(): number {
  return queue.length;
}

/** จำนวน query ที่ถูก await ไปแล้ว */
export function consumedQueries(): number {
  return consumed;
}

function makeChain(): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled: (value: unknown) => unknown) => {
          if (queue.length === 0) {
            throw new Error(
              `dbStub: query ที่ ${consumed + 1} ไม่มีผลลัพธ์เตรียมไว้ — ` +
                'route ยิง query มากกว่าที่เทสคาดไว้',
            );
          }
          consumed += 1;
          return Promise.resolve(queue.shift()).then(onFulfilled);
        };
      }
      // method อื่นของ query builder — คืนลูกโซ่ตัวใหม่เพื่อให้ต่อกันได้เรื่อย ๆ
      return () => makeChain();
    },
    apply() {
      return makeChain();
    },
  });
}

export const db = makeChain();
