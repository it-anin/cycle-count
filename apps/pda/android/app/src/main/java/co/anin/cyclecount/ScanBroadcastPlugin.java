package co.anin.cyclecount;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * รับบาร์โค้ดจากเครื่องสแกนที่ตั้งเป็น Broadcast Mode
 *
 * เครื่อง PDA ยิงบาร์โค้ดออกมาเป็น Android Intent broadcast ไม่ใช่การพิมพ์ตัวอักษร
 * WebView รับ intent เองไม่ได้ จึงต้องมี BroadcastReceiver ฝั่ง native แล้วส่งต่อเข้า JS
 *
 * เหนือกว่าโหมด keyboard-wedge ตรงที่ไม่ขึ้นกับว่าช่องไหนกำลังโฟกัสอยู่
 * บาร์โค้ดจึงไหลลงช่องแก้จำนวนโดยไม่ตั้งใจไม่ได้
 *
 * ## ชื่อ extra
 *
 * action รู้แล้วว่าเป็น com.kte.scan.result แต่ชื่อ extra ที่บาร์โค้ดอยู่ข้างในต่างกันตามรุ่น
 * plugin นี้จึงลองคีย์ที่พบบ่อยตามลำดับ และ **ส่ง extra ทุกตัวกลับขึ้นไปให้ JS เสมอ**
 * เพื่อให้หน้าจอแสดงได้ว่าเครื่องนี้ใช้คีย์ชื่ออะไร — ยิงบาร์โค้ดครั้งเดียวก็รู้
 * โดยไม่ต้องต่อสายดู logcat
 */
@CapacitorPlugin(name = "ScanBroadcast")
public class ScanBroadcastPlugin extends Plugin {

    private static final String TAG = "ScanBroadcast";

    /**
     * คีย์ที่อาจมีบาร์โค้ดอยู่ เรียงตามความน่าจะเป็น
     *
     * "code" คือค่าที่ยืนยันแล้วจากเครื่องจริง (broadcast ส่ง code กับ code_src มาคู่กัน)
     * ที่เหลือเก็บไว้เผื่อเครื่องรุ่นอื่นในอนาคต
     */
    private static final String[] KNOWN_KEYS = {
        "code",
        "value",
        "barcode",
        "data",
        "barcode_string",
        "scannerdata",
        "scanResult",
        "SCAN_BARCODE1",
        "decode_data",
        "EXTRA_SCAN_DATA"
    };

    /**
     * คีย์ที่ **ห้าม** เอามาเป็นบาร์โค้ดเด็ดขาด แม้จะเป็น extra ตัวเดียวที่เหลืออยู่
     *
     * code_src คือชนิดบาร์โค้ด (EAN13 / CODE128 / …) ไม่ใช่ตัวเลขบาร์โค้ด
     * ถ้าเผลอหยิบมาใช้ ระบบจะบันทึกชื่อ symbology เป็นบาร์โค้ดโดยไม่มีใครสังเกต
     */
    private static final java.util.Set<String> IGNORED_KEYS = new java.util.HashSet<>(
        java.util.Arrays.asList("code_src", "codeSrc", "symbology", "barcode_type", "type", "length")
    );

    private BroadcastReceiver receiver;
    private String action = "com.kte.scan.result";
    /** null = ให้เดาเอาจาก KNOWN_KEYS */
    private String extraKey = null;
    private boolean wantsRunning = false;

    @PluginMethod
    public void start(PluginCall call) {
        String requestedAction = call.getString("action");
        if (requestedAction != null && !requestedAction.isEmpty()) {
            action = requestedAction;
        }

        String requestedKey = call.getString("extraKey");
        extraKey = (requestedKey != null && !requestedKey.isEmpty()) ? requestedKey : null;

        wantsRunning = true;
        register();

        JSObject result = new JSObject();
        result.put("action", action);
        result.put("extraKey", extraKey);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        wantsRunning = false;
        unregister();
        call.resolve();
    }

    /**
     * ลงทะเบียนเฉพาะตอนแอปอยู่หน้าจอ
     *
     * broadcast เป็น multicast แอปอื่นบนเครื่องก็รับด้วย ถ้าประกาศ receiver ไว้ใน
     * AndroidManifest แบบถาวร แอปนี้จะรับบาร์โค้ดตอนที่พนักงานกำลังใช้แอปอื่นอยู่
     * แล้วกลายเป็นนับผีเข้าไปในรอบ
     */
    @Override
    protected void handleOnResume() {
        if (wantsRunning) register();
    }

    @Override
    protected void handleOnPause() {
        unregister();
    }

    @Override
    protected void handleOnDestroy() {
        unregister();
    }

    private void register() {
        if (receiver != null) return;

        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleScan(intent);
            }
        };

        // Android 13+ บังคับให้ระบุว่ารับ broadcast จากแอปอื่นได้หรือไม่
        // ไม่ใส่แล้วแอป crash ทันทีที่ register เพราะ broadcast นี้มาจากแอปสแกนของเครื่อง
        ContextCompat.registerReceiver(
            getContext(),
            receiver,
            new IntentFilter(action),
            ContextCompat.RECEIVER_EXPORTED
        );

        Log.i(TAG, "registered for " + action);
    }

    private void unregister() {
        if (receiver == null) return;
        try {
            getContext().unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // ยังไม่เคยลงทะเบียน หรือถูกถอนไปแล้ว
        }
        receiver = null;
        Log.i(TAG, "unregistered");
    }

    private void handleScan(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) {
            Log.w(TAG, "broadcast ไม่มี extras");
            return;
        }

        // ส่ง extra ที่เป็น string ทั้งหมดกลับขึ้นไป ให้หน้าจอโชว์ตอนยังไม่รู้ว่าคีย์ชื่ออะไร
        JSObject all = new JSObject();
        for (String key : extras.keySet()) {
            Object value = extras.get(key);
            if (value instanceof String) {
                all.put(key, (String) value);
            } else if (value instanceof byte[]) {
                all.put(key, new String((byte[]) value));
            } else if (value != null) {
                all.put(key, String.valueOf(value));
            }
        }

        String barcode = null;
        String usedKey = null;

        if (extraKey != null && !IGNORED_KEYS.contains(extraKey)) {
            barcode = readString(extras, extraKey);
            usedKey = extraKey;
        }

        if (isBlank(barcode)) {
            for (String key : KNOWN_KEYS) {
                String candidate = readString(extras, key);
                if (!isBlank(candidate)) {
                    barcode = candidate;
                    usedKey = key;
                    break;
                }
            }
        }

        // ยังไม่เจอ: ถ้าเหลือ extra ที่ไม่ใช่ metadata อยู่ตัวเดียว ก็ต้องเป็นตัวนั้นแหละ
        if (isBlank(barcode)) {
            String only = null;
            boolean ambiguous = false;
            for (String key : extras.keySet()) {
                if (IGNORED_KEYS.contains(key)) continue;
                if (isBlank(readString(extras, key))) continue;
                if (only != null) { ambiguous = true; break; }
                only = key;
            }
            if (only != null && !ambiguous) {
                usedKey = only;
                barcode = readString(extras, only);
            }
        }

        JSObject event = new JSObject();
        event.put("barcode", barcode == null ? "" : trimEndMark(barcode));
        event.put("extraKey", usedKey);
        // ชนิดบาร์โค้ดที่เครื่องบอกมา — ไว้ debug เวลาบาร์โค้ดอ่านได้แต่ไม่ตรง catalog
        event.put("symbology", readString(extras, "code_src"));
        event.put("extras", all);
        notifyListeners("scan", event);

        Log.i(TAG, "scan key=" + usedKey + " extras=" + all.toString());
    }

    private static String readString(Bundle extras, String key) {
        Object value = extras.get(key);
        if (value instanceof String) return (String) value;
        if (value instanceof byte[]) return new String((byte[]) value);
        return null;
    }

    /**
     * ตั้งค่า "Add End Mark: Enter" ไว้ที่เครื่อง บาง firmware ต่อ \r\n มาใน payload ด้วย
     * ตัดทิ้งก่อนส่งขึ้น JS ไม่งั้นบาร์โค้ดจะไม่ match กับ catalog
     */
    private static String trimEndMark(String raw) {
        return raw.replaceAll("[\\r\\n\\t]+$", "").trim();
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }
}
