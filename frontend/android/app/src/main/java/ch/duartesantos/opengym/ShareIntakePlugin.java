package ch.duartesantos.opengym;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Share → openGym: the image a box posts, long-pressed in WhatsApp and shared to the app
 * (ACTION_SEND image/*, AndroidManifest.xml). The image goes to the page as base64 with its type,
 * as a `shared` event; lib/wod-intake.js downscales it and has the server read the program.
 *
 * MainActivity is singleTask, so a share reaches the app one of two ways: as the intent that
 * launches it (cold start) or through onNewIntent while it runs (warm). The cold one arrives
 * before the page has added its listener; the event is retained until it does.
 *
 * Usage from JS (lib/mobile.js):
 *   registerPlugin('ShareIntake').addListener('shared', ({ data, mime }) => ...)
 */
@CapacitorPlugin(name = "ShareIntake")
public class ShareIntakePlugin extends Plugin {

    // A phone photo is a few MB; anything past this is not a routine image, and base64 of it
    // through the bridge would only risk the WebView's memory.
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // Both ways in: BridgeActivity hands its launch intent to every plugin through this same hook
    // once the bridge is up (cold start), and onNewIntent forwards the later ones (warm).
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        read(intent);
    }

    private void read(Intent intent) {
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        // Reopened from Recents, Android hands back the intent the task started with: that share
        // was already read.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;
        Uri uri = streamOf(intent);
        if (uri == null) return;
        // Read once: a configuration change re-creating the activity must not share it again.
        intent.setAction(null);
        // The activity is exported, so any app can send this intent, and the read below runs with
        // openGym's own rights: a file:// path or one of openGym's own providers would have it
        // open its private files (progress photos, exercise media) and send them to the Coach's
        // provider. Only another app's content is read.
        if (!sharedByAnotherApp(uri)) {
            JSObject refused = new JSObject();
            refused.put("error", true);
            notifyListeners("shared", refused, true);
            return;
        }
        io.execute(() -> {
            JSObject ev = new JSObject();
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) throw new java.io.FileNotFoundException(uri.toString());
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BYTES) throw new java.io.IOException("too large");
                }
                String mime = getContext().getContentResolver().getType(uri);
                ev.put("mime", mime != null && mime.startsWith("image/") ? mime : type);
                ev.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            } catch (Exception e) {
                // A sender that revoked its grant, a file that is gone or too large: the page
                // says the image could not be opened rather than showing nothing at all.
                ev.put("error", true);
            }
            notifyListeners("shared", ev, true);
        });
    }

    private boolean sharedByAnotherApp(Uri uri) {
        String authority = uri.getAuthority();
        if (!"content".equals(uri.getScheme()) || authority == null) return false;
        // "10@authority" names the same provider for another user; the user is not the point.
        authority = authority.substring(authority.indexOf('@') + 1);
        // Every provider of this app (the FileProvider is ${applicationId}.fileprovider) starts with it.
        return !authority.startsWith(getContext().getPackageName());
    }

    @SuppressWarnings("deprecation")
    private static Uri streamOf(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return extra instanceof Uri ? (Uri) extra : null;
    }
}
