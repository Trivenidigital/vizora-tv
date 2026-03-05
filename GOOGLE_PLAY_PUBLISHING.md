# Vizora Display - Google Play Store Publishing Guide

This guide walks you through publishing the Vizora Display app to the Google Play Store.

## Prerequisites

- [ ] Google Play Developer Account ($25 one-time fee)
- [ ] Java JDK 11 or higher installed
- [ ] Android Studio (recommended) or command line tools
- [ ] Node.js 18+ installed
- [ ] The Vizora Display source code

---

## Step 1: Create a Release Signing Key

Google Play requires all apps to be signed with a certificate. You'll use this key for all future updates.

### Generate Keystore

```bash
# Navigate to the android directory
cd display-android/android

# Generate a new keystore (keep this file safe - you can't recover it!)
keytool -genkey -v -keystore vizora-release.keystore -alias vizora-display -keyalg RSA -keysize 2048 -validity 10000
```

You'll be prompted for:
- **Keystore password**: Choose a strong password (save this!)
- **Key password**: Can be the same as keystore password
- **Your name**: Your name or company name
- **Organization**: Vizora Inc.
- **City/State/Country**: Your location

### Store Credentials Securely

Create `display-android/android/keystore.properties`:

```properties
storeFile=vizora-release.keystore
storePassword=YOUR_KEYSTORE_PASSWORD
keyAlias=vizora-display
keyPassword=YOUR_KEY_PASSWORD
```

⚠️ **IMPORTANT**:
- Add `keystore.properties` and `*.keystore` to `.gitignore`
- Back up your keystore file and passwords in a secure location
- You cannot update your app without this key!

---

## Step 2: Build the Release App

### Option A: Build APK (For testing/sideloading)

```bash
# From display-android directory
npm run build

# Sync with Android
npx cap sync android

# Build release APK
cd android
./gradlew assembleRelease

# APK location: android/app/build/outputs/apk/release/
```

### Option B: Build AAB (For Play Store - Recommended)

```bash
# From display-android directory
npm run build
npx cap sync android

# Build Android App Bundle
cd android
./gradlew bundleRelease

# AAB location: android/app/build/outputs/bundle/release/
```

The AAB (Android App Bundle) is preferred for Play Store as it allows Google to optimize the app for each device.

---

## Step 3: Set Up Google Play Console

### Create Developer Account

1. Go to [Google Play Console](https://play.google.com/console)
2. Sign in with your Google account
3. Pay the $25 registration fee
4. Complete developer profile

### Create New App

1. Click **"Create app"**
2. Fill in app details:
   - **App name**: Vizora Display
   - **Default language**: English (United States)
   - **App or game**: App
   - **Free or paid**: Free
3. Accept the declarations
4. Click **"Create app"**

---

## Step 4: Store Listing Setup

### Main Store Listing

Navigate to **Grow > Store presence > Main store listing**

#### App Details
| Field | Value |
|-------|-------|
| App name | Vizora Display |
| Short description | Digital signage made simple. Transform any TV into a smart display. |
| Full description | (See store-listing/PLAY_STORE_LISTING.md) |

#### Graphics

Upload the following from `store-listing/` folder:

| Asset | File | Size |
|-------|------|------|
| App icon | icons/app-icon.png | 512 x 512 px |
| Feature graphic | feature-graphic.png | 1024 x 500 px |
| TV banner | icons/tv-banner.png | 1280 x 720 px |
| Screenshots | screenshots/*.png | 1920 x 1080 px |

**Converting SVGs to PNG:**
```bash
# Using ImageMagick
convert -density 300 app-icon.svg -resize 512x512 app-icon.png
convert -density 300 tv-banner.svg -resize 1280x720 tv-banner.png
convert -density 300 feature-graphic.svg -resize 1024x500 feature-graphic.png

# Or use online tools like:
# - svgtopng.com
# - cloudconvert.com
```

### TV-Specific Screenshots

For TV apps, you need 1920x1080 screenshots showing:
1. Pairing screen with QR code
2. Content playing on display
3. D-pad navigation in action
4. Dashboard preview (optional)

---

## Step 5: App Content & Policies

### Content Rating

Navigate to **Policy > App content > Content rating**

1. Click **"Start questionnaire"**
2. Select **"Utility"** category
3. Answer all questions (most will be "No" for Vizora)
4. Submit for rating (should get "Everyone")

### Data Safety

Navigate to **Policy > App content > Data safety**

Fill out the form:

**Data Collection:**
- Device identifiers: Yes (for pairing)
- App interactions: Yes (for analytics)

**Data Usage:**
- App functionality: Yes
- Analytics: Yes
- Advertising: No

**Data Sharing:**
- No data shared with third parties

**Security:**
- Data encrypted in transit: Yes
- Users can request deletion: Yes

### Privacy Policy

1. Create a privacy policy page at `https://vizora.io/privacy`
2. Add URL in **Policy > App content > Privacy policy**

### Target Audience

Navigate to **Policy > App content > Target audience**

- Select **"18 and over"** (business app)
- Confirm no appeal to children

---

## Step 6: App Release

### Set Up Internal Testing (Recommended First)

1. Go to **Release > Testing > Internal testing**
2. Click **"Create new release"**
3. Upload your AAB file
4. Add release notes
5. Click **"Save"** then **"Review release"**
6. **"Start rollout to Internal testing"**

### Add Testers

1. Go to **Release > Testing > Internal testing > Testers**
2. Create a new email list
3. Add tester emails
4. Testers will receive a link to install

### Production Release

Once testing is complete:

1. Go to **Release > Production**
2. Click **"Create new release"**
3. Upload your AAB (or promote from testing)
4. Add release notes:
   ```
   Version 1.0.0 - Initial Release

   - Easy QR code pairing with Vizora dashboard
   - Support for images, videos, PDFs, and web content
   - D-pad remote control navigation
   - Auto-start on boot
   - Real-time content updates
   ```
5. Click **"Review release"**
6. **"Start rollout to Production"**

---

## Step 7: App Review

Google will review your app. This typically takes:
- **First submission**: 1-7 days
- **Updates**: 1-3 days

### Common Rejection Reasons

1. **Missing privacy policy** - Ensure URL is accessible
2. **Broken functionality** - Test thoroughly before submission
3. **Misleading description** - Be accurate about features
4. **TV requirements not met** - Ensure D-pad navigation works

---

## Post-Launch Checklist

- [ ] Monitor Play Console for crashes (Firebase Crashlytics recommended)
- [ ] Respond to user reviews
- [ ] Track installs and ratings
- [ ] Plan regular updates
- [ ] Set up staged rollouts for updates

---

## Updating Your App

For future updates:

1. **Increment version** in `android/app/build.gradle`:
   ```gradle
   versionCode 2  // Increment by 1
   versionName "1.1.0"  // Semantic versioning
   ```

2. **Build new AAB**:
   ```bash
   npm run build
   npx cap sync android
   cd android && ./gradlew bundleRelease
   ```

3. **Upload to Play Console** and create new release

---

## Useful Commands

```bash
# Clean build
cd android && ./gradlew clean

# Build debug APK (for testing)
./gradlew assembleDebug

# Build release APK
./gradlew assembleRelease

# Build release AAB (for Play Store)
./gradlew bundleRelease

# Install debug on connected device
./gradlew installDebug

# View signing info
keytool -list -v -keystore vizora-release.keystore
```

---

## Support Resources

- [Play Console Help](https://support.google.com/googleplay/android-developer)
- [Android TV Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [App Bundle Documentation](https://developer.android.com/guide/app-bundle)
- [Release Signing](https://developer.android.com/studio/publish/app-signing)

---

## File Locations Summary

```
display-android/
├── android/
│   ├── keystore.properties      # Signing credentials (DO NOT COMMIT)
│   ├── vizora-release.keystore  # Signing key (DO NOT COMMIT)
│   └── app/
│       └── build/
│           └── outputs/
│               ├── apk/release/     # Release APK
│               └── bundle/release/  # Release AAB
├── store-listing/
│   ├── PLAY_STORE_LISTING.md    # Store listing content
│   ├── feature-graphic.svg       # 1024x500 feature graphic
│   ├── icons/
│   │   ├── app-icon.svg          # 512x512 app icon
│   │   └── tv-banner.svg         # 1280x720 TV banner
│   └── screenshots/              # TV screenshots
└── GOOGLE_PLAY_PUBLISHING.md    # This guide
```
