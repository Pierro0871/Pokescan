package fr.pierrick.pokescan;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // écran demandé par un raccourci (appui long sur l'icône) ou la tuile : lu par l'appli au démarrage
    static volatile String pendingView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdater.class);
        registerPlugin(HomeWidget.class);
        registerPlugin(NativeScan.class);
        pendingView = viewOf(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String v = viewOf(intent);
        if (v != null && getBridge() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript("window.goShortcut && goShortcut('" + v + "')", null));
        }
    }

    private static String viewOf(Intent i) {
        String v = i == null ? null : i.getStringExtra("view");
        return v == null ? null : v.replaceAll("[^a-z]", "");
    }
}
