package fr.pierrick.pokescan;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

// Widget écran d'accueil : valeur de la collection, nombre de cartes, progression
public class PokeWidget extends AppWidgetProvider {
    static final String PREFS = "pokescan_widget";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        PendingIntent open = PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.poke_widget);
            v.setTextViewText(R.id.w_value, p.getString("value", "Ouvre PokeScan"));
            v.setTextViewText(R.id.w_cards, p.getString("cards", ""));
            v.setTextViewText(R.id.w_progress, p.getString("progress", ""));
            v.setOnClickPendingIntent(R.id.w_root, open);
            m.updateAppWidget(id, v);
        }
    }
}
