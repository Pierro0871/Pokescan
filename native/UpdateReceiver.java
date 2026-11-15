package fr.pierrick.pokescan;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

// Résultat de l'installation d'une mise à jour, et relance de l'appli une fois mise à jour
public class UpdateReceiver extends BroadcastReceiver {
    static final String STATUS = "fr.pierrick.pokescan.UPDATE_STATUS";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            try {
                ctx.startActivity(new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) { } // Android peut refuser de rouvrir l'appli en arrière-plan
            return;
        }
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // première fois (ou Android < 12) : Android demande une confirmation
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(confirm); }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            ctx.getSharedPreferences("update", Context.MODE_PRIVATE).edit().putString("error", msg == null ? "code " + status : msg).apply();
            // refus (Play Protect, sécurité du téléphone…) : on passe par l'installeur du téléphone, qui marche toujours
            if (ApkUpdater.openWithInstaller(ctx)) { // y compris « ABORTED » : Play Protect / Xiaomi annulent l'installation sans demander
                Toast.makeText(ctx, "Installation par l'installeur du téléphone…", Toast.LENGTH_LONG).show();
            } else {
                Toast.makeText(ctx, "Mise à jour non installée : " + (msg == null ? "code " + status : msg), Toast.LENGTH_LONG).show();
            }
        }
    }
}
