package fr.pierrick.pokescan;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Reçoit les chiffres de la collection depuis l'appli et rafraîchit le widget
@CapacitorPlugin(name = "HomeWidget")
public class HomeWidget extends Plugin {
    @PluginMethod
    public void update(PluginCall call) {
        Context ctx = getContext();
        ctx.getSharedPreferences(PokeWidget.PREFS, Context.MODE_PRIVATE).edit()
                .putString("value", call.getString("value", "–"))
                .putString("cards", call.getString("cards", ""))
                .putString("progress", call.getString("progress", ""))
                .apply();
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] ids = m.getAppWidgetIds(new ComponentName(ctx, PokeWidget.class));
        Intent i = new Intent(ctx, PokeWidget.class).setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        ctx.sendBroadcast(i);
        call.resolve();
    }
}
