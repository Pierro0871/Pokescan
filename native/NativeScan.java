package fr.pierrick.pokescan;

import android.Manifest;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;
import android.util.Size;
import android.graphics.Outline;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.tasks.Tasks;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import org.tensorflow.lite.Interpreter;

// Moteur de scan natif : caméra (CameraX) derrière la page web transparente, lecture du texte (ML Kit)
// et empreinte d'image (TensorFlow Lite) comparée à toute la base. Chaque image analysée -> événement « frame ».
@CapacitorPlugin(name = "NativeScan", permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") })
public class NativeScan extends Plugin {
    private static final String RELEASES = "https://github.com/Pierro0871/Pokescan/releases/download/";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ProcessCameraProvider provider;
    private Camera camera;
    private FrameLayout box;
    private PreviewView preview;
    private Drawable oldBg;
    private float radius = 0;
    private volatile float gx = 0.1f, gy = 0.1f, gw = 0.8f, gh = 0.8f; // cadre guide, relatif à la zone caméra
    private volatile boolean paused = false, busy = false;
    private volatile long last = 0;
    private TextRecognizer text;
    private Interpreter model;
    private byte[] emb;
    private int dim = 0, count = 0, size = 224;
    private final Object lock = new Object();

    private File dir() { File d = new File(getContext().getFilesDir(), "index"); d.mkdirs(); return d; }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        File d = dir();
        r.put("meta", new File(d, "meta.json.gz").exists());
        r.put("emb", new File(d, "emb.bin").length());
        r.put("model", new File(d, "model.tflite").exists());
        r.put("loaded", model != null);
        r.put("cards", count);
        call.resolve(r);
    }

    // ---------- index ----------
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", ""), name = call.getString("name", "");
        if (!url.startsWith(RELEASES) || !name.matches("[a-z.]+")) { call.reject("URL refusée"); return; }
        new Thread(() -> {
            File tmp = new File(dir(), name + ".part"), out = new File(dir(), name);
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(20000); c.setReadTimeout(30000);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                long total = c.getContentLengthLong(), done = 0, shown = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream o = new FileOutputStream(tmp)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) {
                        o.write(b, 0, n); done += n;
                        if (done - shown > 400000) {
                            shown = done;
                            JSObject p = new JSObject(); p.put("name", name); p.put("done", done); p.put("total", total);
                            notifyListeners("dl", p);
                        }
                    }
                }
                if (!tmp.renameTo(out)) throw new Exception("écriture impossible");
                JSObject r = new JSObject(); r.put("size", out.length()); call.resolve(r);
            } catch (Exception e) { tmp.delete(); call.reject(e.getMessage()); }
        }).start();
    }

    @PluginMethod
    public void readMeta(PluginCall call) {
        worker.execute(() -> {
            try (InputStream in = new GZIPInputStream(new FileInputStream(new File(dir(), "meta.json.gz")))) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) o.write(b, 0, n);
                JSObject r = new JSObject(); r.put("json", new String(o.toByteArray(), StandardCharsets.UTF_8)); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PluginMethod
    public void loadIndex(PluginCall call) {
        int d = call.getInt("dim", 576), s = call.getInt("size", 224);
        worker.execute(() -> {
            try {
                File m = new File(dir(), "model.tflite"), e = new File(dir(), "emb.bin");
                byte[] all = new byte[(int) e.length()];
                try (FileInputStream in = new FileInputStream(e)) { int off = 0, n; while (off < all.length && (n = in.read(all, off, all.length - off)) > 0) off += n; }
                Interpreter.Options o = new Interpreter.Options(); o.setNumThreads(2);
                Interpreter it = new Interpreter(m, o);
                synchronized (lock) {
                    if (model != null) model.close();
                    model = it; emb = all; dim = d; size = s; count = all.length / d;
                }
                JSObject r = new JSObject(); r.put("cards", count); call.resolve(r);
            } catch (Throwable t) { call.reject("index illisible : " + t.getMessage()); }
        });
    }

    // ---------- caméra ----------
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) { requestPermissionForAlias("camera", call, "camPerm"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                if (text == null) text = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                WebView web = bridge.getWebView();
                ViewGroup parent = (ViewGroup) web.getParent();
                if (box == null) {
                    box = new FrameLayout(getContext());
                    preview = new PreviewView(getContext());
                    preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
                    preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
                    box.setClipToOutline(true);
                    box.setOutlineProvider(new ViewOutlineProvider() {
                        @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radius); }
                    });
                    box.addView(preview, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    parent.addView(box, 0, new ViewGroup.LayoutParams(1, 1));
                    oldBg = parent.getBackground();
                }
                parent.setBackgroundColor(parseColor(call.getString("bg", "#101418")));
                web.setBackgroundColor(Color.TRANSPARENT);
                place(call);
                paused = false;
                ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(getContext());
                f.addListener(() -> {
                    try {
                        provider = f.get();
                        ResolutionSelector rs = new ResolutionSelector.Builder()
                                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                                .setResolutionStrategy(new ResolutionStrategy(new Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                                .build();
                        Preview p = new Preview.Builder().setResolutionSelector(rs).build();
                        p.setSurfaceProvider(preview.getSurfaceProvider());
                        ImageAnalysis a = new ImageAnalysis.Builder().setResolutionSelector(rs)
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888).build();
                        a.setAnalyzer(worker, this::analyze);
                        provider.unbindAll();
                        camera = provider.bindToLifecycle((LifecycleOwner) getActivity(), CameraSelector.DEFAULT_BACK_CAMERA, p, a);
                        JSObject r = new JSObject();
                        r.put("torch", camera.getCameraInfo().hasFlashUnit());
                        Float lo = camera.getCameraInfo().getZoomState().getValue() != null ? camera.getCameraInfo().getZoomState().getValue().getMinZoomRatio() : 1f;
                        Float hi = camera.getCameraInfo().getZoomState().getValue() != null ? camera.getCameraInfo().getZoomState().getValue().getMaxZoomRatio() : 1f;
                        r.put("minZoom", lo); r.put("maxZoom", hi);
                        call.resolve(r);
                    } catch (Exception e) { call.reject("caméra : " + e.getMessage()); }
                }, ContextCompat.getMainExecutor(getContext()));
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PermissionCallback
    private void camPerm(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) start(call); else call.reject("Autorisation caméra refusée");
    }

    private static int parseColor(String c) { try { return Color.parseColor(c); } catch (Exception e) { return Color.BLACK; } }

    // Zone caméra = rectangle #cam de la page (pixels CSS) ; cadre guide relatif à cette zone
    private void place(PluginCall call) {
        if (box == null) return;
        WebView web = bridge.getWebView();
        double vw = call.getDouble("vw", 0d);
        float k = vw > 0 ? (float) (web.getWidth() / vw) : getContext().getResources().getDisplayMetrics().density;
        float x = call.getFloat("x", 0f) * k, y = call.getFloat("y", 0f) * k, w = call.getFloat("w", 1f) * k, h = call.getFloat("h", 1f) * k;
        ViewGroup.LayoutParams lp = box.getLayoutParams();
        lp.width = Math.max(1, Math.round(w)); lp.height = Math.max(1, Math.round(h));
        box.setLayoutParams(lp);
        box.setX(web.getX() + x); box.setY(web.getY() + y);
        radius = call.getFloat("r", 16f) * k;
        box.invalidateOutline();
        JSObject g = call.getObject("guide");
        if (g != null) {
            gx = (float) g.optDouble("x", gx); gy = (float) g.optDouble("y", gy);
            gw = (float) g.optDouble("w", gw); gh = (float) g.optDouble("h", gh);
        }
    }

    @PluginMethod
    public void setRect(PluginCall call) { getActivity().runOnUiThread(() -> { place(call); call.resolve(); }); }

    @PluginMethod
    public void pause(PluginCall call) { paused = call.getBoolean("on", true); call.resolve(); }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (provider != null) provider.unbindAll();
            camera = null;
            if (box != null) {
                ViewGroup parent = (ViewGroup) box.getParent();
                if (parent != null) { parent.removeView(box); parent.setBackground(oldBg); }
                box = null; preview = null;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void torch(PluginCall call) {
        if (camera == null) { call.reject("caméra arrêtée"); return; }
        camera.getCameraControl().enableTorch(call.getBoolean("on", false));
        call.resolve();
    }

    @PluginMethod
    public void zoom(PluginCall call) {
        if (camera == null) { call.reject("caméra arrêtée"); return; }
        camera.getCameraControl().setZoomRatio(call.getFloat("ratio", 1f));
        call.resolve();
    }

    @PluginMethod
    public void focus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (camera == null || preview == null) { call.reject("caméra arrêtée"); return; }
            MeteringPoint p = preview.getMeteringPointFactory().createPoint(call.getFloat("x", 0.5f) * preview.getWidth(), call.getFloat("y", 0.5f) * preview.getHeight());
            camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(p).build());
            call.resolve();
        });
    }

    // ---------- analyse d'une image ----------
    private void analyze(ImageProxy img) {
        long now = SystemClock.elapsedRealtime();
        if (paused || now - last < 110 || preview == null) { img.close(); return; }
        last = now;
        long t0 = now;
        Bitmap full;
        int rot;
        try { full = img.toBitmap(); rot = img.getImageInfo().getRotationDegrees(); } finally { img.close(); }
        try {
            if (rot != 0) { Matrix m = new Matrix(); m.postRotate(rot); full = Bitmap.createBitmap(full, 0, 0, full.getWidth(), full.getHeight(), m, true); }
            // image affichée en « remplir » dans la zone caméra : on retrouve le cadre guide dans l'image
            float vw = Math.max(1, preview.getWidth()), vh = Math.max(1, preview.getHeight()), bw = full.getWidth(), bh = full.getHeight();
            float s = Math.max(vw / bw, vh / bh), ox = (vw - bw * s) / 2, oy = (vh - bh * s) / 2;
            Rect card = clamp((gx * vw - ox) / s, (gy * vh - oy) / s, gw * vw / s, gh * vh / s, full);
            float mx = card.width() * 0.08f, my = card.height() * 0.06f; // marge : la carte déborde souvent un peu
            Rect wide = clamp(card.left - mx, card.top - my, card.width() + 2 * mx, card.height() + 2 * my, full);
            Bitmap cb = Bitmap.createBitmap(full, card.left, card.top, card.width(), card.height());
            Bitmap tb = Bitmap.createBitmap(full, wide.left, wide.top, wide.width(), wide.height());
            JSObject ev = new JSObject();
            ev.put("sharp", sharpness(cb));
            // texte
            JSArray lines = new JSArray();
            Text t = Tasks.await(text.process(InputImage.fromBitmap(tb, 0)));
            for (Text.TextBlock b : t.getTextBlocks()) for (Text.Line l : b.getLines()) {
                Rect r = l.getBoundingBox();
                if (r == null) continue;
                JSObject o = new JSObject();
                o.put("t", l.getText());
                o.put("x", round3((r.left + wide.left - card.left) / (float) card.width()));
                o.put("y", round3((r.top + wide.top - card.top) / (float) card.height()));
                o.put("w", round3(r.width() / (float) card.width()));
                o.put("h", round3(r.height() / (float) card.height()));
                lines.put(o);
            }
            ev.put("lines", lines);
            ev.put("ocrMs", SystemClock.elapsedRealtime() - t0);
            // image : empreinte comparée à toutes les cartes, 200 plus proches
            synchronized (lock) {
                if (model != null && emb != null) top(cb, ev);
            }
            ev.put("ms", SystemClock.elapsedRealtime() - t0);
            if (!paused) notifyListeners("frame", ev);
        } catch (Throwable e) {
            JSObject ev = new JSObject(); ev.put("error", String.valueOf(e.getMessage())); notifyListeners("frame", ev);
        }
    }

    private static double round3(float v) { return Math.round(v * 1000) / 1000.0; }

    private static Rect clamp(float x, float y, float w, float h, Bitmap b) {
        int l = Math.max(0, Math.round(x)), t = Math.max(0, Math.round(y));
        int r = Math.min(b.getWidth(), Math.round(x + w)), bo = Math.min(b.getHeight(), Math.round(y + h));
        if (r - l < 8 || bo - t < 8) return new Rect(0, 0, b.getWidth(), b.getHeight());
        return new Rect(l, t, r, bo);
    }

    // Netteté : variance du laplacien sur une petite version en gris
    private static double sharpness(Bitmap b) {
        int w = 160, h = Math.max(8, Math.round(160f * b.getHeight() / b.getWidth()));
        Bitmap s = Bitmap.createScaledBitmap(b, w, h, true);
        int[] px = new int[w * h];
        s.getPixels(px, 0, w, 0, 0, w, h);
        float[] g = new float[w * h];
        for (int i = 0; i < px.length; i++) { int c = px[i]; g[i] = (((c >> 16) & 255) * 3 + ((c >> 8) & 255) * 6 + (c & 255)) / 10f; }
        double sum = 0, sq = 0; int n = 0;
        for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
            int i = y * w + x;
            double l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
            sum += l; sq += l * l; n++;
        }
        double m = sum / n;
        return Math.round((sq / n - m * m) * 10) / 10.0;
    }

    private void top(Bitmap cb, JSObject ev) {
        long t0 = SystemClock.elapsedRealtime();
        Bitmap s = Bitmap.createScaledBitmap(cb, size, size, true);
        int[] px = new int[size * size];
        s.getPixels(px, 0, size, 0, 0, size, size);
        ByteBuffer in = ByteBuffer.allocateDirect(4 * 3 * size * size).order(ByteOrder.nativeOrder());
        for (int c : px) { in.putFloat((c >> 16) & 255); in.putFloat((c >> 8) & 255); in.putFloat(c & 255); }
        in.rewind();
        float[][] out = new float[1][dim];
        model.run(in, out);
        float[] q = out[0];
        double n = 0;
        for (float v : q) n += v * v;
        float inv = (float) (1 / Math.max(1e-6, Math.sqrt(n)) / 127.0);
        for (int i = 0; i < dim; i++) q[i] *= inv;
        // tas des K meilleures (score, n° de carte)
        final int K = Math.min(200, count);
        float[] hs = new float[K]; int[] hi = new int[K]; int hn = 0;
        for (int c = 0, off = 0; c < count; c++, off += dim) {
            float sc = 0;
            for (int i = 0; i < dim; i++) sc += q[i] * emb[off + i];
            if (hn < K) { hs[hn] = sc; hi[hn] = c; up(hs, hi, hn++); }
            else if (sc > hs[0]) { hs[0] = sc; hi[0] = c; down(hs, hi, K); }
        }
        // tri décroissant
        Integer[] ord = new Integer[hn];
        for (int i = 0; i < hn; i++) ord[i] = i;
        java.util.Arrays.sort(ord, (a, b) -> Float.compare(hs[b], hs[a]));
        JSArray ids = new JSArray(), sc = new JSArray();
        for (int i : ord) { ids.put(hi[i]); try { sc.put(Math.round(hs[i] * 1000) / 1000.0); } catch (org.json.JSONException e) { sc.put(0); } }
        ev.put("ids", ids); ev.put("sc", sc);
        ev.put("embMs", SystemClock.elapsedRealtime() - t0);
    }

    private static void up(float[] s, int[] id, int i) {
        while (i > 0) { int p = (i - 1) / 2; if (s[p] <= s[i]) break; swap(s, id, p, i); i = p; }
    }
    private static void down(float[] s, int[] id, int n) {
        int i = 0;
        while (true) {
            int l = 2 * i + 1, r = l + 1, m = i;
            if (l < n && s[l] < s[m]) m = l;
            if (r < n && s[r] < s[m]) m = r;
            if (m == i) return;
            swap(s, id, i, m); i = m;
        }
    }
    private static void swap(float[] s, int[] id, int a, int b) { float t = s[a]; s[a] = s[b]; s[b] = t; int u = id[a]; id[a] = id[b]; id[b] = u; }
}
