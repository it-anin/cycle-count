---
name: pda-app-structure
description: ใช้เมื่อแก้โค้ดใน apps/pda (หน้าจอนับ, scanner, localStorage/IndexedDB, Android/Capacitor) — มีโครงสร้างไฟล์ กับดักเครื่องสแกน Broadcast Mode และ gotcha การ build APK
---

# apps/pda — แอปบนเครื่อง

```
src/
├── App.tsx                     สลับ Login ↔ CountLedger
├── screens/LoginScreen.tsx     รหัสพนักงาน + PIN (คีย์แพดของแอปเอง)
├── screens/CountLedgerScreen.tsx   หน้าจอนับ เลย์เอาต์ "สมุดบัญชี" 480×800 แนวตั้ง
└── lib/
    ├── api.ts                  เลือก mock หรือ HTTP จาก VITE_API_BASE_URL + lookup() ค้นในเครื่อง
    ├── supabase.ts             client สำหรับ auth เท่านั้น (ไม่ได้ใช้ query ข้อมูล)
    ├── catalogCache.ts         เก็บ catalog ลง IndexedDB
    ├── useLedger.ts            สมุดบัญชี + persist แบบ debounce + ล็อกกันสแกนซ้ำ
    ├── submittedLog.ts         SKU ที่ส่งสำเร็จแล้วต่อรอบ — append-only กันส่งทับยอดเดิม
    ├── useScanner.ts           รวมสัญญาณจาก native plugin + ช่องพิมพ์เอง
    └── nativeScanner.ts        สะพานไป ScanBroadcastPlugin
```

**SKU ที่ส่งสำเร็จแล้วจะถูกล็อก สแกนซ้ำไม่เข้าสมุดอีก** — กันกับดักทยอยส่ง: สมุดถูกล้างว่าง
หลังส่งทุกครั้ง ถ้าไม่ล็อก ส่ง 5 กล่องแล้วเดินต่อเจออีก 3 แล้วสแกนใหม่ จะ upsert ทับเหลือ 3 ไม่ใช่ 8

เลือกปิดกั้นที่จุดสแกนแทนการเปลี่ยน server ให้บวกเพิ่ม เพราะการบวกจะทำลาย retry-safety เดิม
(ส่งก้อนเดิมซ้ำตอนเน็ตกระตุกต้องยังปลอดภัย เพราะ upsert ทับด้วยค่าเดิม)

```
android/app/src/
├── main/java/co/anin/cyclecount/
│   ├── MainActivity.java           register plugin
│   └── ScanBroadcastPlugin.java    รับ broadcast com.kte.scan.result
└── debug/                          overlay เฉพาะ debug build — เปิด cleartext HTTP ใน LAN
```

## เครื่องสแกนเป็น Broadcast Mode เปลี่ยนไม่ได้

PDA ตั้ง `Data Output Mode: Broadcast Mode` (ไม่ใช่ keyboard-wedge) เพราะแอปอื่นบนเครื่องใช้ค่านี้อยู่
บาร์โค้ดมาเป็น Android Intent `com.kte.scan.result` ซึ่ง WebView รับเองไม่ได้

| | ค่า |
|---|---|
| extra ที่มีบาร์โค้ด | **`code`** |
| extra ชนิดบาร์โค้ด | `code_src` — อยู่ใน `IGNORED_KEYS` **ห้ามหยิบมาเป็นบาร์โค้ด** |

สองเรื่องที่แก้พลาดไม่ได้ใน `ScanBroadcastPlugin.java`:

- **register receiver เฉพาะตอนแอปอยู่หน้าจอ** (`handleOnResume` / `handleOnPause`)
  ถ้าประกาศถาวรใน manifest แอปจะรับบาร์โค้ดตอนพนักงานใช้แอปอื่นอยู่ → นับผีเข้ารอบ
- **`ContextCompat.RECEIVER_EXPORTED`** — targetSdk 34 บังคับ ไม่ใส่แล้ว crash ทันทีที่เปิด

**ผลคือเทสการสแกนในเบราว์เซอร์ไม่ได้ ต้อง build APK** (เทสเลย์เอาต์/ปุ่มยังได้ ใช้ปุ่ม "คีย์เอง")

## `authEmailForEmployee()` ต้องเป็นตัวเดียวกันทั้งสองฝั่ง

`EMP-2041` → `emp2041@pda.anin.co.th` หน้าล็อกอินและสคริปต์สร้างผู้ใช้เรียกฟังก์ชันเดียวกัน
**เปลี่ยน `PDA_AUTH_DOMAIN` = ผู้ใช้เดิมทั้งหมดล็อกอินไม่ได้** เพราะ map ไปคนละอีเมล
ฟังก์ชันอยู่ใน `packages/core/auth.ts` ใช้ร่วมกับ `apps/web/src/app/login` และ
`packages/db/src/createUser.ts`

## คีย์ที่เก็บลงเครื่องต้องมีเวอร์ชันเสมอ

`cc:ledger:v2:<sessionId>`, `cc:submitted:v1:<sessionId>`, `cc:scanExtraKey`
และต้องอ่านใน `try/catch` แล้วคืนค่าว่างถ้าพัง (ข้อมูลค้างจากเวอร์ชันเก่าต้องไม่ทำให้จอขาว)
catalog ใช้ IndexedDB แทนเพราะ 2 MB ชนโควตาของ localStorage

## เรื่องปลีกย่อยที่เคยกัดมาแล้ว

- **Gradle ต้อง 8.7 ขึ้นไป** — Capacitor generate มาเป็น 8.2.1 ซึ่งไม่รองรับ JDK 21
  ลบ `android/` แล้ว `cap add` ใหม่ต้องแก้ `gradle-wrapper.properties` ซ้ำ
- **cleartext HTTP** — `src/debug/` overlay ให้ debug build เรียก API ใน LAN ได้
  (Android บล็อก HTTP ธรรมดาตั้งแต่ API 28 — อาการคือล็อกอินผ่านแต่เรียก API ไม่ได้
  เพราะ Supabase เป็น https ส่วน API เป็น http)

## คำสั่ง

```bash
pnpm --filter @cycle-count/pda android:apk      # → android/app/build/outputs/apk/debug/
```

**ห้าม commit `*.apk`** และ**ห้าม ignore `apps/pda/android/` ทั้งโฟลเดอร์** — ข้างในมีโค้ด
native ที่เขียนเอง สร้างใหม่จาก `cap add android` ไม่ได้
