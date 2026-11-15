package fr.pierrick.pokescan;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Mise à jour dans l'appli : téléchargement avec progression, puis installation par le service d'installation
// d'Android (PackageInstaller) au lieu de l'installeur du téléphone. À partir d'Android 12, une fois que PokeScan
// s'est mise à jour elle-même une première fois, les mises à jour suivantes s'installent sans écran de confirmation.
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdater extends Plugin {
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://github.com/Pierro0871/Pokescan/releases/download/")) { call.reject("URL refusée"); return; }
        Context ctx = getContext();
        new Thread(() -> {
            try {
                File f = new File(ctx.getCacheDir(), "PokeScan-update.apk");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(20000); c.setReadTimeout(30000);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                long total = c.getContentLengthLong(), done = 0, shown = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) {
                        out.write(b, 0, n); done += n;
                        if (done - shown > 300000) { shown = done; progress("download", done, total); }
                    }
                }
                progress("install", total, total);
                PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(ctx.getPackageName());
                p.setSize(f.length());
                if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                int id = pi.createSession(p);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    try (OutputStream o = s.openWrite("base.apk", 0, f.length()); InputStream in = new FileInputStream(f)) {
                        byte[] b = new byte[65536];
                        int n;
                        while ((n = in.read(b)) > 0) o.write(b, 0, n);
                        s.fsync(o);
                    }
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent pend = PendingIntent.getBroadcast(ctx, id, new Intent(ctx, UpdateReceiver.class).setAction(UpdateReceiver.STATUS), flags);
                    s.commit(pend.getIntentSender());
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    private void progress(String step, long done, long total) {
        JSObject p = new JSObject();
        p.put("step", step); p.put("done", done); p.put("total", total);
        notifyListeners("progress", p);
    }

    // Dernière erreur d'installation (lue par l'appli)
    @PluginMethod
    public void lastError(PluginCall call) {
        android.content.SharedPreferences sp = getContext().getSharedPreferences("update", Context.MODE_PRIVATE);
        JSObject r = new JSObject(); r.put("error", sp.getString("error", null));
        sp.edit().remove("error").apply();
        call.resolve(r);
    }
}
