# Vizora Android TV App - Build Instructions

This guide explains how to build and deploy the Vizora Android TV display app.

## Prerequisites

1. **Node.js** (v18 or later)
2. **Android Studio** (latest version)
3. **Java JDK 17** (required for Android builds)
4. **Android SDK** with:
   - Android SDK Platform 34 (Android 14)
   - Android SDK Build-Tools
   - Android TV system images (for emulator testing)

## Initial Setup

### 1. Install Dependencies

```bash
cd display-android
npm install
```

### 2. Initialize Capacitor

```bash
# Initialize Capacitor (only needed once)
npx cap init "Vizora Display" "com.vizora.display" --web-dir dist

# Add Android platform
npx cap add android
```

### 3. Configure Environment

Copy the example environment file and update with your server URLs:

```bash
cp .env.example .env
```

Edit `.env`:
```env
VITE_API_URL=https://api.yourdomain.com
VITE_REALTIME_URL=wss://realtime.yourdomain.com
VITE_DASHBOARD_URL=https://dashboard.yourdomain.com
```

## Building the App

### Development Build

```bash
# Build web assets and sync to Android
npm run android:build

# Open in Android Studio
npm run cap:open
```

### Production Build

1. **Build web assets:**
   ```bash
   npm run build
   ```

2. **Sync with Android:**
   ```bash
   npx cap sync android
   ```

3. **Open Android Studio:**
   ```bash
   npx cap open android
   ```

4. **Generate signed APK/AAB:**
   - In Android Studio: Build → Generate Signed Bundle/APK
   - Choose APK for direct installation or AAB for Play Store

## Android TV Specific Configuration

### AndroidManifest.xml Modifications

After running `cap add android`, modify `android/app/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- Add TV-specific attributes -->
    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <!-- For network access -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <!-- For auto-start on boot -->
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

    <!-- Keep screen on -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:banner="@drawable/banner"
        android:networkSecurityConfig="@xml/network_security_config">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:screenOrientation="landscape"
            android:keepScreenOn="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <!-- For Android TV -->
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>

        <!-- Boot receiver for auto-start -->
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
```

### Create Boot Receiver

Create `android/app/src/main/java/com/vizora/display/BootReceiver.java`:

```java
package com.vizora.display;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
        }
    }
}
```

### Add Leanback Theme

Add to `android/app/build.gradle`:

```gradle
dependencies {
    implementation 'androidx.leanback:leanback:1.0.0'
}
```

## Testing

### Android TV Emulator

1. Open Android Studio → Device Manager
2. Create new device → TV → Android TV (1080p)
3. Select system image (API 34 recommended)
4. Start emulator

### Physical Android TV

1. Enable Developer Options on your TV
2. Enable USB Debugging
3. Connect via ADB:
   ```bash
   adb connect <TV_IP_ADDRESS>:5555
   ```
4. Run the app:
   ```bash
   npx cap run android --target <TV_DEVICE_ID>
   ```

### Fire TV

1. Enable ADB Debugging in Fire TV settings
2. Connect via ADB:
   ```bash
   adb connect <FIRE_TV_IP>:5555
   ```
3. Install the APK:
   ```bash
   adb install app-release.apk
   ```

## Deployment

### Google Play Store (Android TV)

1. Generate signed AAB (Android App Bundle)
2. Create Google Play Console account
3. Create new app → TV → Digital Signage
4. Upload AAB and fill in store listing
5. Submit for review

### Direct APK Distribution

For enterprise/internal deployment:

1. Build signed APK
2. Host APK on your server
3. Install via:
   - USB drive
   - ADB sideload
   - MDM (Mobile Device Management)

### Amazon Fire TV

1. Generate signed APK
2. Create Amazon Developer account
3. Submit to Amazon Appstore
4. Or sideload directly via ADB

## Troubleshooting

### App crashes on launch
- Check logcat for errors: `adb logcat | grep -i vizora`
- Ensure network permissions are granted
- Verify server URLs are accessible

### Content not loading
- Check network connectivity
- Verify CORS settings on your server
- Check SSL certificates for HTTPS

### D-pad navigation issues
- Ensure focusable elements have `class="focusable"`
- Test with Android TV remote emulator

### Auto-start not working
- Verify RECEIVE_BOOT_COMPLETED permission
- Check if battery optimization is disabled for the app

## Resources

- [Capacitor Documentation](https://capacitorjs.com/docs)
- [Android TV Development](https://developer.android.com/training/tv)
- [Leanback Library](https://developer.android.com/training/tv/start/start)
