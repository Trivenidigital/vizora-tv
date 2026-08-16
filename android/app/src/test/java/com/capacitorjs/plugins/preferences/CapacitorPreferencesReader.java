package com.capacitorjs.plugins.preferences;

import android.content.Context;

/**
 * Test-only reader that goes through the Capacitor Preferences plugin's OWN storage layer.
 *
 * Lives in the plugin's package (test source set only) because both {@link Preferences}'
 * constructor and {@link PreferencesConfiguration#DEFAULTS} are package-private. Reading the
 * marker through this — rather than through a SharedPreferences handle opened with the same
 * string literals the Java writer used — is what makes "the web layer can actually see it" a
 * checked claim instead of a restatement of the write.
 */
public final class CapacitorPreferencesReader {

    private CapacitorPreferencesReader() {}

    /** Exactly what {@code Preferences.get({key})} resolves to on the JS side. */
    public static String get(Context context, String key) {
        return new Preferences(context, PreferencesConfiguration.DEFAULTS).get(key);
    }
}
