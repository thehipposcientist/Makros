# Android Testing And Deployment

Last updated: 2026-05-07

## Current Android Beta Scope

This Android beta is the phone app first. Health Connect and Wear OS are follow-up integrations. Expected to work for testers:

- Auth, onboarding, deterministic workout plan generation, active workouts, custom activities, meal logging, hydration, supplements, weight/history, scans, coach/check-in flows, notifications, and backend sync.
- Manual health/recovery mode when Health Connect is unavailable.

Not included yet:

- Health Connect reads/writes.
- Wear OS companion app.
- Apple Watch sync and iOS Live Activities.

## Local Android Setup

Use Java 17 for local Android builds. Java 25 currently fails Gradle plugin resolution in this repo.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Install Android Studio or command-line Android SDK tools if `$ANDROID_HOME` does not exist. Then verify:

```bash
java -version
adb version
cd android && ./gradlew --version
```

Run locally on an emulator or USB device:

```bash
npx expo run:android
```

## Google Sign-In Requirement

Android Google sign-in needs an Android OAuth client in Google Cloud:

- Package name: `com.thallo.app`
- SHA-1 certificate fingerprint: use the signing key for the build being tested.
- Set `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` or `GOOGLE_ANDROID_CLIENT_ID` before building.

For EAS builds, get the signing certificate fingerprint with:

```bash
eas credentials -p android
```

For Play Internal App Sharing, Google re-signs uploaded artifacts with an internal app sharing certificate. Download/copy that certificate fingerprint in Play Console if Google sign-in must work from those links.

## Fast Tester Deployment: EAS Internal APK

This repo's `preview` profile is configured for internal Android APK builds.

```bash
eas login
eas build --platform android --profile preview
```

When the build finishes, share the EAS install URL with Android testers. They install the APK directly from that link. They may need to allow installs from the browser or file manager on their device.

Expo reference: https://docs.expo.dev/build/internal-distribution

## Play Store Tester Deployment

Use this when you want Play-managed installs, updates, and a more realistic release path.

```bash
eas build --platform android --profile production
```

Upload the generated AAB to Play Console:

1. Create or open the `com.thallo.app` Android app in Play Console.
2. Go to Testing -> Internal testing.
3. Create a tester email list.
4. Create a release and upload the AAB.
5. Roll out to internal testing.
6. Share the opt-in link with testers.

Google Play reference: https://support.google.com/googleplay/android-developer/answer/9845334

For very quick link-based sharing without a managed testing track, use Play Console Internal App Sharing and upload the APK/AAB. Links expire after 60 days and each link supports up to 100 downloads.

Internal App Sharing reference: https://support.google.com/googleplay/android-developer/answer/9844679

## Preflight Before Sharing

```bash
npm run typecheck
npm run test:frontend
npx expo-doctor
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./android/gradlew -p android assembleDebug
```

If the local Android SDK is not installed, EAS cloud builds can still be used for distribution, but local emulator testing will be blocked until Android Studio/SDK is installed.

