package fr.pierrick.pokescan;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdater.class);
        registerPlugin(HomeWidget.class);
        super.onCreate(savedInstanceState);
    }
}
