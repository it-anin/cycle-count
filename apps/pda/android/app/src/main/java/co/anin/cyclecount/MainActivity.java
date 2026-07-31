package co.anin.cyclecount;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ต้อง register ก่อน super.onCreate() ไม่งั้น bridge ถูกสร้างไปแล้วและมองไม่เห็น plugin
        registerPlugin(ScanBroadcastPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
