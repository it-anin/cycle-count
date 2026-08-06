/**
 * หน้าจอนับสต็อกแบบ "สมุดบัญชี" (แบบที่ 5)
 *
 * **หนึ่งแถว = หนึ่ง SKU** ไม่ใช่หนึ่งหน่วย เพราะผลต่างคิดที่หน่วยฐานเสมอ
 * SKU ที่ยิงทั้งกล่องและแผงจึงต้องอยู่แถวเดียวกัน ไม่งั้นผลต่างจะไม่รู้ว่าควรโชว์ที่แถวไหน
 *
 * ในแถวโชว์ breakdown ว่ายิงหน่วยไหนไปเท่าไหร่ พร้อมกำกับหน่วยฐาน (3 กล่อง = 36 ชิ้น)
 * แตะที่หน่วยไหนก็แก้จำนวนของหน่วยนั้นได้ทันที
 *
 * ออกแบบสำหรับจอ 480×800 แนวตั้ง
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  countedBaseQty,
  varianceKind,
  type CatalogConflict,
  type LedgerRow,
} from '@cycle-count/core';

import { mockBarcodes, usingMock, type CurrentUser, type SessionInfo } from '../lib/api';
import { nativeScannerAvailable, SCAN_ACTION } from '../lib/nativeScanner';
import { useLedger } from '../lib/useLedger';
import { useScanDiagnostics, useScanner } from '../lib/useScanner';

interface Props {
  user: CurrentUser;
  session: SessionInfo;
  /** จำนวนบาร์โค้ดที่โหลดลงเครื่องแล้ว — ยืนยันให้คนนับเห็นว่า catalog พร้อม */
  catalogCount: number;
  /** version ที่ต้องตรงกับ server ตอนส่ง */
  catalogVersion: string;
  onSignOut: () => Promise<void>;
}

const num = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 4 });

function catalogConflictText(conflict: CatalogConflict): string {
  switch (conflict.reason) {
    case 'barcode_removed':
      return 'บาร์โค้ดถูกนำออกจาก master';
    case 'became_known':
      return `เดิมไม่พบสินค้า ปัจจุบันเป็น SKU ${conflict.latest?.sku ?? '—'}`;
    case 'sku_changed':
      return `เปลี่ยนเป็น SKU ${conflict.latest?.sku ?? '—'}`;
    case 'uom_changed':
      return `เปลี่ยนหน่วยเป็น ${conflict.latest?.uom ?? '—'}`;
    case 'factor_changed':
      return `เปลี่ยนตัวคูณเป็น ×${num(conflict.latest?.factorToBase ?? 0)}`;
    case 'base_uom_changed':
      return `เปลี่ยนหน่วยฐานเป็น ${conflict.latest?.baseUom ?? '—'}`;
  }
}

function varianceLabel(row: LedgerRow): { text: string; kind: string } {
  const kind = varianceKind(row);
  if (kind === 'unknown') return { text: '—', kind };
  const v = countedBaseQty(row) - (row.expectedBaseQty ?? 0);
  if (v === 0) return { text: '0', kind };
  return { text: v > 0 ? `+${num(v)}` : `−${num(Math.abs(v))}`, kind };
}

/** แถวที่มีหน่วยเดียวและตัวคูณ 1 ไม่ต้องกำกับหน่วยฐาน เพราะเลขเท่ากันอยู่แล้ว */
function needsBaseHint(row: LedgerRow): boolean {
  return row.units.length > 1 || row.units.some((u) => u.factorToBase !== 1);
}

interface RowProps {
  row: LedgerRow;
  blind: boolean;
  /** อยู่บนสุด = เพิ่งยิงมา ใช้ไฮไลต์ให้เห็นว่าอันไหนคือของที่เพิ่งนับ */
  isNewest: boolean;
  isEditing: boolean;
  /** หน่วยที่กำลังแก้อยู่ในแถวนี้ — null เมื่อไม่ได้แก้แถวนี้ */
  editingUom: string | null;
  hasCatalogConflict: boolean;
  conflictingUoms?: ReadonlySet<string>;
  onPickUnit: (key: string, uom: string) => void;
}

/**
 * หนึ่งแถวในสมุด — ห่อ memo() ไว้เพราะรายการยาวได้ถึงหลักร้อย
 *
 * ถ้าไม่ห่อ การยิงบาร์โค้ดหนึ่งครั้งตอนมี 300 SKU จะทำให้ React วาดใหม่ทั้ง 300 แถว
 * ทั้งที่จริงมีแค่สองแถวที่เปลี่ยน (แถวที่ถูกดันขึ้นบนสุด กับแถวเดิมที่เสียตำแหน่งบนสุดไป)
 *
 * ใช้ได้ผลเพราะฝั่ง core รักษา object identity ของแถวที่ไม่ถูกแตะไว้อยู่แล้ว:
 * applyScan() ใช้ rows.map((r) => r.key === key ? updated : r) และ hoist() ใช้ slice()+splice()
 * ทั้งคู่คืน reference เดิม — shallow compare ของ memo() จึงข้ามแถวที่ไม่เกี่ยวได้จริง
 *
 * ⚠ props ทุกตัวต้องนิ่ง ถ้าเผลอส่ง object/arrow ที่สร้างใหม่ทุกรอบเข้ามา memo จะไร้ผลทันที
 */
const LedgerRowView = memo(function LedgerRowView({
  row,
  blind,
  isNewest,
  isEditing,
  editingUom,
  hasCatalogConflict,
  conflictingUoms,
  onPickUnit,
}: RowProps) {
  const v = varianceLabel(row);
  const baseQty = countedBaseQty(row);

  return (
    <div
      className={[
        'cc-row',
        isNewest && !isEditing ? 'cc-row--new' : '',
        isEditing ? 'cc-row--editing' : '',
        row.flagged ? 'cc-row--flagged' : '',
        hasCatalogConflict ? 'cc-row--catalog-conflict' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* รอบ blind แถบสีต้องไม่สื่อสถานะ ไม่งั้นก็เท่ากับบอกผลต่างทางอ้อม */}
      <span
        className={`cc-row__stripe cc-row__stripe--${blind ? 'plain' : v.kind}`}
        aria-hidden="true"
      />
      <span className="cc-row__main">
        <span className="cc-row__sku">
          {row.sku ?? row.units[0]?.lastBarcode}
          {row.location && <span className="cc-row__loc">{row.location}</span>}
        </span>
        <span className="cc-row__name">{row.name}</span>
        {hasCatalogConflict && (
          <span className="cc-row__catalog-warn">ข้อมูลเปลี่ยน · ต้องนับใหม่</span>
        )}
        <span className="cc-row__units">
          {row.units.map((u) => (
            <button
              key={u.uom}
              type="button"
              className={[
                'cc-unit',
                editingUom === u.uom ? 'cc-unit--on' : '',
                conflictingUoms?.has(u.uom) ? 'cc-unit--catalog-conflict' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onPickUnit(row.key, u.uom)}
            >
              <b>{num(u.qty)}</b> {u.uom}
              {u.factorToBase !== 1 && <i>×{num(u.factorToBase)}</i>}
            </button>
          ))}
          {needsBaseHint(row) && (
            <span className="cc-row__base">
              = {num(baseQty)} {row.baseUom}
            </span>
          )}
        </span>
      </span>
      <span className="cc-row__qty">{num(baseQty)}</span>
      {!blind && <span className={`cc-row__var cc-row__var--${v.kind}`}>{v.text}</span>}
    </div>
  );
});

export default function CountLedgerScreen({
  user,
  session,
  catalogCount,
  catalogVersion,
  onSignOut,
}: Props) {
  /**
   * รอบ blind ไม่มียอดระบบให้เทียบ — ตัดคอลัมน์ผลต่างออกทั้งคอลัมน์
   * ดีกว่าโชว์ `—` ทุกแถวซึ่งกินที่ฟรีและชวนให้คนนับสงสัยว่าระบบเสีย
   */
  const blind = session.mode === 'blind';

  const {
    rows,
    totals,
    scanState,
    submitState,
    catalogConflicts,
    scan,
    setUnitQty,
    bumpUnitQty,
    removeUnit,
    submit,
    dismissSubmit,
  } = useLedger(session.id, catalogVersion);

  const [typed, setTyped] = useState('');
  const [manualEntry, setManualEntry] = useState(false);
  const [scanFocused, setScanFocused] = useState(false);
  /** แก้จำนวนของหน่วยหนึ่งในแถวหนึ่ง */
  const [edit, setEdit] = useState<{ key: string; uom: string; pristine: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [catalogNoticeOpen, setCatalogNoticeOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const previousConflictCount = useRef(0);

  const editRow = useMemo(
    () => (edit ? (rows.find((r) => r.key === edit.key) ?? null) : null),
    [edit, rows],
  );
  const editUnit = useMemo(
    () => (edit && editRow ? (editRow.units.find((u) => u.uom === edit.uom) ?? null) : null),
    [edit, editRow],
  );

  // แถว/หน่วยที่กำลังแก้อาจถูกลบไปแล้ว — ปิดแผงตาม ไม่ให้ค้างอ้างของที่ไม่มี
  useEffect(() => {
    if (edit && !editUnit) setEdit(null);
  }, [edit, editUnit]);

  const busy = edit !== null || confirming || leaving || catalogNoticeOpen;
  const scanDiag = useScanDiagnostics();

  const conflictUomsByRow = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const conflict of catalogConflicts) {
      const uoms = result.get(conflict.rowKey) ?? new Set<string>();
      uoms.add(conflict.uom);
      result.set(conflict.rowKey, uoms);
    }
    return result;
  }, [catalogConflicts]);
  const editHasConflict =
    edit !== null &&
    catalogConflicts.some((conflict) => conflict.rowKey === edit.key && conflict.uom === edit.uom);

  useEffect(() => {
    if (previousConflictCount.current === 0 && catalogConflicts.length > 0) {
      setCatalogNoticeOpen(true);
    } else if (catalogConflicts.length === 0) {
      setCatalogNoticeOpen(false);
    }
    previousConflictCount.current = catalogConflicts.length;
  }, [catalogConflicts.length]);

  /** ต้องนิ่งข้าม render ไม่งั้น memo() ของ LedgerRowView จะพังทุกแถว */
  const pickUnit = useCallback((key: string, uom: string) => {
    setEdit({ key, uom, pristine: true });
  }, []);

  /**
   * โหมด broadcast ไม่ต้องแย่งโฟกัสให้ช่องสแกน เพราะบาร์โค้ดมาทาง Intent ไม่ใช่คีย์บอร์ด
   * เหลือคาโฟกัสเฉพาะตอนเทสในเบราว์เซอร์ที่ยังใช้ keyboard-wedge อยู่
   */
  useEffect(() => {
    if (nativeScannerAvailable || busy) return;
    scanRef.current?.focus();
  }, [busy, rows.length]);

  // ของที่เพิ่งยิงแทรกอยู่บนสุดเสมอ — เลื่อนขึ้นไปให้เห็นแม้ผู้ใช้เลื่อนดูแถวเก่าค้างไว้
  useEffect(() => {
    if (scanState.kind === 'found' || scanState.kind === 'unknown') {
      rowsRef.current?.scrollTo({ top: 0 });
    }
  }, [scanState]);

  useScanner(
    (barcode) => {
      scan(barcode);
      setTyped('');
      if (edit) setEdit(null);
    },
    {
      enabled: catalogConflicts.length === 0 && (nativeScannerAvailable || (!busy && !scanFocused)),
      onUnrecognized: scanDiag.onUnrecognized,
    },
  );

  function submitTyped() {
    const code = typed.trim();
    if (!code) return;
    scan(code);
    setTyped('');
    setManualEntry(false);
  }

  /** พิมพ์ตัวเลขทับค่าเดิมในการกดครั้งแรก แล้วต่อท้ายในครั้งถัด ๆ ไป */
  function pressDigit(digit: string) {
    if (!edit || !editUnit) return;
    const current = edit.pristine ? '' : String(editUnit.qty);
    const next = (current + digit).replace(/^0+(?=\d)/, '').slice(0, 7);
    setUnitQty(edit.key, edit.uom, Number(next));
    setEdit({ ...edit, pristine: false });
  }

  function pressBackspace() {
    if (!edit || !editUnit) return;
    const current = String(editUnit.qty);
    const next = current.length <= 1 ? '0' : current.slice(0, -1);
    setUnitQty(edit.key, edit.uom, Number(next));
    setEdit({ ...edit, pristine: false });
  }

  function pressBump(delta: number) {
    if (!edit) return;
    bumpUnitQty(edit.key, edit.uom, delta);
    setEdit({ ...edit, pristine: false });
  }

  const scanHint = (() => {
    if (catalogConflicts.length > 0) {
      return {
        text: `ข้อมูลเปลี่ยน ${catalogConflicts.length} หน่วย · ลบรายการสีแดงแล้วนับใหม่`,
        tone: 'bad' as const,
      };
    }

    switch (scanState.kind) {
      case 'locked':
        return {
          text: `${scanState.entry.name} — นับไปแล้ว ${num(scanState.entry.baseQty)} ${scanState.entry.baseUom}`,
          tone: 'locked' as const,
        };
      case 'unknown':
        return { text: 'ไม่พบบาร์โค้ดนี้', tone: 'bad' as const };
      case 'found': {
        const row = rows.find((r) => r.key === scanState.key);
        const unit = row?.units.find((u) => u.uom === scanState.uom);
        if (unit && unit.scanCount > 1) {
          return {
            text: `ยิงซ้ำ · ${num(unit.qty)} ${unit.uom}`,
            tone: 'warn' as const,
          };
        }
        return { text: 'รับแล้ว', tone: 'good' as const };
      }
      default:
        return { text: 'ยิงต่อได้เลย', tone: 'idle' as const };
    }
  })();

  return (
    <div className={`cc ${blind ? 'cc--blind' : ''}`}>
      <header className="cc-top">
        <button
          type="button"
          className="cc-top__user"
          aria-label={`${user.name} — แตะเพื่อออกจากระบบ`}
          onClick={() => setLeaving(true)}
        >
          {user.name} · {user.employeeCode}
          {user.warehouse && ` · ${user.warehouse}`}
        </button>
        <span className="cc-top__session">
          <span className={`cc-mode cc-mode--${session.mode}`}>{blind ? 'ปิดยอด' : 'รอบทวน'}</span>
          <b>{session.code}</b> · {session.location}
        </span>
      </header>

      <div className={`cc-scan cc-scan--${scanHint.tone}`}>
        <span className="cc-bars" aria-hidden="true" />
        <input
          ref={scanRef}
          className="cc-scan__input"
          value={typed}
          /*
           * โหมด broadcast: ช่องนี้มีไว้คีย์มือตอนฉลากเสียเท่านั้น เปิดคีย์บอร์ดปกติได้เลย
           * โหมด keyboard-wedge: ต้อง inputMode=none กันคีย์บอร์ด Android เด้งมาบังครึ่งจอ
           */
          inputMode={nativeScannerAvailable || manualEntry ? 'text' : 'none'}
          enterKeyHint="enter"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={catalogConflicts.length > 0}
          placeholder={
            catalogConflicts.length > 0
              ? 'ต้องแก้รายการที่ข้อมูลเปลี่ยนก่อน'
              : nativeScannerAvailable
                ? 'ยิงบาร์โค้ด หรือแตะเพื่อคีย์เอง'
                : 'ยิงบาร์โค้ด'
          }
          aria-label="ช่องสแกนบาร์โค้ด"
          onChange={(e) => setTyped(e.target.value)}
          onFocus={() => setScanFocused(true)}
          onBlur={() => setScanFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitTyped();
            }
          }}
        />
        <span className={`cc-scan__hint cc-scan__hint--${scanHint.tone}`}>{scanHint.text}</span>
        {!nativeScannerAvailable && (
          <button
            type="button"
            className="cc-scan__manual"
            aria-label="คีย์บาร์โค้ดเอง"
            disabled={catalogConflicts.length > 0}
            onClick={() => {
              setManualEntry(true);
              scanRef.current?.focus();
            }}
          >
            คีย์เอง
          </button>
        )}
      </div>

      <div className="cc-colhead">
        <span>SKU / ชื่อสินค้า</span>
        <span>{blind ? 'จำนวน' : `รวม (${rows[0]?.baseUom ?? 'หน่วยฐาน'})`}</span>
        {!blind && <span>ผลต่าง</span>}
      </div>

      <div className="cc-rows" ref={rowsRef}>
        {rows.length === 0 ? (
          <div className="cc-empty">
            <span className="cc-bars cc-bars--lg" aria-hidden="true" />
            <p className="cc-empty__title">ยังไม่ได้นับอะไรในรอบนี้</p>
            <p className="cc-empty__sub">ยิงบาร์โค้ดแล้วรายการจะขึ้นมาที่นี่</p>
            <p className="cc-empty__ready">
              โหลดรายการสินค้าลงเครื่องแล้ว {num(catalogCount)} บาร์โค้ด
            </p>
            {usingMock && (
              <p className="cc-empty__dev">
                โหมดทดสอบ — ยังไม่ได้ต่อ API จริง กดปุ่ม “ยิงตัวอย่าง” ด้านล่างได้
              </p>
            )}
          </div>
        ) : (
          rows.map((row, i) => (
            <LedgerRowView
              key={row.key}
              row={row}
              blind={blind}
              isNewest={i === 0}
              isEditing={edit?.key === row.key}
              editingUom={edit?.key === row.key ? edit.uom : null}
              hasCatalogConflict={conflictUomsByRow.has(row.key)}
              conflictingUoms={conflictUomsByRow.get(row.key)}
              onPickUnit={pickUnit}
            />
          ))
        )}
      </div>

      {editRow && editUnit ? (
        <div className="cc-pad">
          <div className="cc-pad__head">
            <span className="cc-pad__ctx">
              <b>{editRow.sku ?? editUnit.lastBarcode}</b> {editRow.name}
            </span>
            <span className="cc-pad__val">
              {num(editUnit.qty)} <i>{editUnit.uom}</i>
              {editUnit.factorToBase !== 1 && (
                <i>
                  {' '}
                  = {num(editUnit.qty * editUnit.factorToBase)} {editRow.baseUom}
                </i>
              )}
            </span>
          </div>
          {editHasConflict && (
            <p className="cc-pad__catalog-warn">
              ข้อมูลของหน่วยนี้เปลี่ยนใน master กรุณาลบหน่วยแล้วสแกนและนับใหม่
            </p>
          )}
          <div className="cc-pad__grid">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
              <button
                key={d}
                type="button"
                className="cc-key"
                disabled={catalogConflicts.length > 0}
                onClick={() => pressDigit(d)}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              className="cc-key cc-key--fn"
              disabled={catalogConflicts.length > 0}
              onClick={() => pressBump(-1)}
            >
              −1
            </button>
            <button
              type="button"
              className="cc-key cc-key--fn"
              disabled={catalogConflicts.length > 0}
              onClick={() => pressBump(1)}
            >
              +1
            </button>
            <button
              type="button"
              className="cc-key cc-key--fn"
              disabled={catalogConflicts.length > 0}
              onClick={pressBackspace}
            >
              ⌫
            </button>
            <button
              type="button"
              className="cc-key cc-key--danger"
              disabled={catalogConflicts.length > 0 && !editHasConflict}
              onClick={() => removeUnit(editRow.key, editUnit.uom)}
            >
              ลบหน่วย
            </button>
            <button type="button" className="cc-key cc-key--go" onClick={() => setEdit(null)}>
              เสร็จ
            </button>
          </div>
        </div>
      ) : (
        <footer className="cc-foot">
          <div className="cc-foot__stat">
            <span className="cc-k">SKU</span>
            <b>{num(totals.skuCount)}</b>
          </div>
          <div className="cc-foot__stat">
            <span className="cc-k">รวม</span>
            <b>{num(totals.totalBaseQty)}</b>
          </div>
          {usingMock && (
            <button
              type="button"
              className="cc-foot__dev"
              onClick={() => {
                const pick = mockBarcodes[Math.floor(Math.random() * mockBarcodes.length)]!;
                scan(pick);
              }}
            >
              ยิงตัวอย่าง
            </button>
          )}
          <button
            type="button"
            className="cc-foot__send"
            disabled={rows.length === 0 || catalogConflicts.length > 0}
            onClick={() => setConfirming(true)}
          >
            ส่งผลการนับ
          </button>
        </footer>
      )}

      {confirming && (
        <div className="cc-sheet" role="dialog" aria-modal="true" aria-label="ยืนยันส่งผลการนับ">
          <div className="cc-sheet__panel">
            <h2 className="cc-sheet__title">ส่งผลการนับ {session.code}</h2>

            {/* รอบ blind สรุปได้แค่สิ่งที่คนนับนับเอง เทียบผลต่างเป็นงานของแอดมินหลังปิดรอบ */}
            {blind ? (
              <dl className="cc-sheet__stats cc-sheet__stats--3">
                <div>
                  <dt>SKU</dt>
                  <dd>{num(totals.skuCount)}</dd>
                </div>
                <div>
                  <dt>บรรทัด</dt>
                  <dd>{num(totals.lineCount)}</dd>
                </div>
                <div>
                  <dt>รวมหน่วยฐาน</dt>
                  <dd>{num(totals.totalBaseQty)}</dd>
                </div>
              </dl>
            ) : (
              <dl className="cc-sheet__stats">
                <div>
                  <dt>SKU</dt>
                  <dd>{num(totals.skuCount)}</dd>
                </div>
                <div>
                  <dt>ตรง</dt>
                  <dd className="v-match">{num(totals.matched)}</dd>
                </div>
                <div>
                  <dt>ขาด</dt>
                  <dd className="v-short">{num(totals.short)}</dd>
                </div>
                <div>
                  <dt>เกิน</dt>
                  <dd className="v-over">{num(totals.over)}</dd>
                </div>
              </dl>
            )}

            {blind && totals.unknown > 0 && (
              <p className="cc-sheet__warn">
                ไม่พบใน master {num(totals.unknown)} รายการ — แอดมินต้องตรวจก่อนปิดรอบ
              </p>
            )}

            {!blind && (totals.unknown > 0 || totals.withoutExpected > 0) && (
              <p className="cc-sheet__warn">
                {totals.unknown > 0 && `ไม่พบใน master ${num(totals.unknown)} รายการ`}
                {totals.unknown > 0 && totals.withoutExpected > 0 && ' · '}
                {totals.withoutExpected > 0 &&
                  `ไม่มียอดตั้งต้น ${num(totals.withoutExpected)} รายการ`}
                {' — แอดมินต้องตรวจก่อนปิดรอบ'}
              </p>
            )}

            {submitState.kind === 'error' && <p className="cc-sheet__err">{submitState.message}</p>}
            <div className="cc-sheet__btns">
              <button
                type="button"
                className="cc-sheet__cancel"
                disabled={submitState.kind === 'sending'}
                onClick={() => {
                  dismissSubmit();
                  setConfirming(false);
                }}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="cc-sheet__ok"
                disabled={submitState.kind === 'sending'}
                onClick={async () => {
                  const outcome = await submit();
                  if (outcome !== 'error') setConfirming(false);
                }}
              >
                {submitState.kind === 'sending' ? 'กำลังตรวจและส่ง…' : 'ยืนยันส่ง'}
              </button>
            </div>
          </div>
        </div>
      )}

      {catalogNoticeOpen && catalogConflicts.length > 0 && (
        <div className="cc-sheet" role="dialog" aria-modal="true" aria-label="รายการสินค้าเปลี่ยน">
          <div className="cc-sheet__panel">
            <h2 className="cc-sheet__title">รายการสินค้าในระบบเปลี่ยน</h2>
            <p className="cc-sheet__warn">
              ยังไม่ได้ส่งผลการนับ กรุณาลบหน่วยด้านล่างแล้วสแกนและนับใหม่ด้วยข้อมูลล่าสุด
            </p>
            <ul className="cc-catalog-conflicts">
              {catalogConflicts.map((conflict) => (
                <li key={`${conflict.rowKey}|${conflict.uom}|${conflict.barcode}`}>
                  <b>{conflict.name}</b>
                  <span>
                    {conflict.barcode} · {conflict.uom}
                  </span>
                  <em>{catalogConflictText(conflict)}</em>
                </li>
              ))}
            </ul>
            <div className="cc-sheet__btns">
              <button
                type="button"
                className="cc-sheet__ok"
                onClick={() => setCatalogNoticeOpen(false)}
              >
                กลับไปแก้รายการ
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        ยิงติดแต่ plugin หาบาร์โค้ดใน extra ไม่เจอ — โชว์ extra ทั้งหมดที่ broadcast ส่งมา
        อ่านจากจอ PDA ได้เลยว่ารุ่นนี้ใช้คีย์ชื่ออะไร ไม่ต้องต่อสายดู logcat
      */}
      {scanDiag.lastUnrecognized && (
        <div className="cc-sheet" role="dialog" aria-modal="true" aria-label="ตรวจสอบสัญญาณสแกน">
          <div className="cc-sheet__panel">
            <h2 className="cc-sheet__title">รับสัญญาณสแกนได้ แต่หาบาร์โค้ดไม่เจอ</h2>
            <p className="cc-sheet__warn">
              broadcast <code>{SCAN_ACTION}</code> มาถึงแล้ว
              แต่แอปยังไม่รู้ว่าบาร์โค้ดอยู่ในช่องชื่ออะไร
              ดูรายการข้างล่างว่าช่องไหนมีบาร์โค้ดที่เพิ่งยิง แล้วแจ้งชื่อช่องนั้นให้ทีมพัฒนา
            </p>

            <div className="cc-diag">
              {Object.entries(scanDiag.lastUnrecognized.extras).length === 0 ? (
                <p className="cc-diag__empty">broadcast นี้ไม่มีข้อมูลแนบมาเลย</p>
              ) : (
                Object.entries(scanDiag.lastUnrecognized.extras).map(([key, value]) => (
                  <div key={key} className="cc-diag__row">
                    <span className="cc-diag__key">{key}</span>
                    <span className="cc-diag__val">{value}</span>
                  </div>
                ))
              )}
            </div>

            <div className="cc-sheet__btns">
              <button type="button" className="cc-sheet__cancel" onClick={scanDiag.clear}>
                ปิด
              </button>
              <button
                type="button"
                className="cc-sheet__ok"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(JSON.stringify(scanDiag.lastUnrecognized?.extras ?? {}, null, 2))
                    .catch(() => undefined);
                }}
              >
                คัดลอกรายการ
              </button>
            </div>
          </div>
        </div>
      )}

      {leaving && (
        <div className="cc-sheet" role="dialog" aria-modal="true" aria-label="ออกจากระบบ">
          <div className="cc-sheet__panel">
            <h2 className="cc-sheet__title">ออกจากระบบ</h2>
            {rows.length > 0 ? (
              <p className="cc-sheet__warn">
                ยังมี {num(rows.length)} รายการที่ยังไม่ได้ส่ง — ข้อมูลถูกเก็บไว้ในเครื่อง
                ล็อกอินด้วยรหัสเดิมแล้วจะได้กลับมาครบ
              </p>
            ) : (
              <p className="cc-sheet__warn">ส่งผลครบแล้ว ออกจากระบบได้เลย</p>
            )}
            <div className="cc-sheet__btns">
              <button type="button" className="cc-sheet__cancel" onClick={() => setLeaving(false)}>
                ยกเลิก
              </button>
              <button type="button" className="cc-sheet__ok" onClick={() => void onSignOut()}>
                ออกจากระบบ
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        ใบเฉลยหลังส่ง — ตัวเลขนี้มาจาก server ไม่ได้อยู่ในเครื่องมาก่อน
        รอบ blind จึงยังปิดยอดตอนนับได้ แต่คนนับรู้ทันทีว่าต้องเดินกลับไปดูตัวไหน
      */}
      {submitState.kind === 'done' && (
        <div className="cc-sheet" role="dialog" aria-modal="true" aria-label="ผลการนับ">
          <div className="cc-sheet__panel">
            <h2 className="cc-sheet__title">ส่งแล้ว {num(submitState.saved)} รายการ</h2>

            <dl className="cc-sheet__stats">
              <div>
                <dt>ตรง</dt>
                <dd className="v-match">{num(submitState.variance.matched)}</dd>
              </div>
              <div>
                <dt>ขาด</dt>
                <dd className="v-short">{num(submitState.variance.short)}</dd>
              </div>
              <div>
                <dt>เกิน</dt>
                <dd className="v-over">{num(submitState.variance.over)}</dd>
              </div>
              <div>
                <dt>ตรวจ</dt>
                <dd className="v-unknown">
                  {num(submitState.variance.unknown + submitState.variance.withoutExpected)}
                </dd>
              </div>
            </dl>

            {submitState.variance.items.length === 0 ? (
              <p className="cc-result__ok">
                {submitState.variance.matched > 0
                  ? 'ตรงกับยอดระบบทุกรายการ ไม่ต้องนับซ้ำ'
                  : 'บันทึกแล้ว แต่รอบนี้ยังไม่มียอดตั้งต้นให้เทียบ'}
              </p>
            ) : (
              <>
                <p className="cc-result__lead">ต้องกลับไปนับซ้ำ</p>
                <ul className="cc-result__list">
                  {submitState.variance.items.map((item) => (
                    <li key={item.sku ?? item.name} className="cc-result__row">
                      <div className="cc-result__main">
                        <span className="cc-result__name">{item.name}</span>
                        <span className="cc-result__meta">
                          {item.sku ?? '—'} · นับได้ {num(item.countedBaseQty)} {item.baseUom}
                        </span>
                      </div>
                      <span
                        className={`cc-result__diff ${
                          item.diff === null ? 'v-unknown' : item.diff < 0 ? 'v-short' : 'v-over'
                        }`}
                      >
                        {item.diff === null
                          ? 'ไม่มียอดตั้งต้น'
                          : `${item.diff > 0 ? '+' : ''}${num(item.diff)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {submitState.variance.unknown > 0 && (
              <p className="cc-sheet__warn">
                ไม่พบใน master {num(submitState.variance.unknown)} รายการ — บันทึกไว้แล้ว
                แอดมินต้องตรวจก่อนปิดรอบ
              </p>
            )}

            <div className="cc-sheet__btns">
              <button type="button" className="cc-sheet__ok" onClick={dismissSubmit}>
                นับต่อ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
