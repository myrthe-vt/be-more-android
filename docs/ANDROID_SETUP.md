# Android Setup Guide

This guide builds and configures the Android body for the Be More Agent v0.9.0 beta.

The Android application provides BMO's fullscreen face, wake-word audio, command recording, camera capture, device state, and Spotify playback. The Mac backend provides speech recognition, AI, voice output, memory, and integrations.

## Requirements

- Android 8.0 or newer (`minSdk 26`)
- Android Studio with Android SDK 37
- JDK 17 or newer for the Gradle build
- USB debugging or another APK installation method
- A reachable Be More Agent Mac backend
- Tailscale on both devices for the recommended private-network setup
- The Spotify Android app and Spotify Premium for Spotify App Remote features

The project uses Gradle Wrapper 9.7.1 and Android Gradle Plugin 9.3.2. You do not need to install Gradle separately.

## Get the source

Clone the repository on the development computer:

```bash
git clone https://github.com/myrthe-vt/be-more-android.git
cd be-more-android/android
```

On Windows PowerShell:

```powershell
git clone https://github.com/myrthe-vt/be-more-android.git
cd be-more-android\android
```

## Open the project

Open the repository's `android` directory in Android Studio, not the repository root.

Allow Android Studio to:

1. Use the Gradle wrapper from the repository.
2. Install any missing Android SDK 37 components.
3. Complete Gradle synchronization.

The app configuration is:

| Setting | Value |
|---|---|
| Application ID | `com.sapphi.bmo` |
| Minimum SDK | 26 |
| Target SDK | 37 |
| Compile SDK | 37 |
| App version | `0.9.0` |
| Orientation | Landscape |

## Build a debug APK

On Windows:

```powershell
cd C:\GitHub\be-more-android\android
.\gradlew.bat testDebugUnitTest assembleDebug
```

On macOS or Linux:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The debug APK is created at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Install the debug APK

You can run the app directly from Android Studio or install the APK through Android Debug Bridge:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On first launch, Android requests microphone access. Camera access is requested when a vision feature is first used.

## Configure the Mac backend

Start the backend on the Mac:

```bash
cd ~/be-more-agent
./start-bmo.sh
```

Confirm the status endpoint works locally:

```bash
curl http://127.0.0.1:8000/api/status
```

Find the Mac's Tailscale IPv4 address:

```bash
tailscale ip -4
```

The recommended Android backend address is:

```text
http://MAC_TAILSCALE_IP:8000
```

On the Android setup screen, enter the complete base address without a trailing path. Do not enter `/static/face.html` or `/api/status`.

The address is stored only in the Android application's private preferences. It is not compiled into the APK.

The current beta permits HTTP for trusted private networks. Do not use an untrusted or publicly exposed HTTP backend.

## Configure Spotify App Remote

Spotify playback requires a Spotify developer application that recognizes your Android build.

1. Create or select an application in the Spotify Developer Dashboard.
2. Add the Android package name `com.sapphi.bmo`.
3. Register the SHA-1 fingerprint of the certificate used to sign your APK.
4. Add the redirect URI used by the Android client.
5. Replace `SPOTIFY_CLIENT_ID` in `MainActivity.kt` with your application client ID if you are building your own distribution.
6. Keep the redirect URI in the Spotify dashboard and `MainActivity.kt` identical.

The current source uses:

```text
Package: com.sapphi.bmo
Redirect URI: https://com.sapphi.bmo/callback
```

Find the debug signing fingerprint with:

```bash
keytool -list -v \
  -alias androiddebugkey \
  -keystore "$HOME/.android/debug.keystore" \
  -storepass android \
  -keypass android
```

For a release APK, register the SHA-1 fingerprint of the release key instead. Debug and release builds normally have different certificate fingerprints.

The Spotify client secret belongs only in the Mac's ignored `.env` file. Never put a Spotify client secret in Android source code.

## Permissions

| Permission | Purpose |
|---|---|
| Microphone | Wake-word detection and command recording |
| Camera | Explicit still-image vision requests |
| Internet | Communication with the Mac and Spotify |
| Network state | Connection detection and recovery |
| Boot completed | Restoring Android-side behavior after reboot |

Google Calendar is accessed by the Mac backend and does not require Android Calendar permission.

## Initial smoke test

After installation:

1. Start the Mac backend.
2. Open BMO on Android.
3. Configure the backend address if prompted.
4. Confirm the BMO face loads.
5. Allow microphone access.
6. Trigger the wake word and complete one spoken request.
7. Test touch interaction and audio output.
8. Test one camera request after allowing camera access.
9. If configured, test Spotify play, pause, next, and now-playing state.
10. Disconnect and reconnect the network briefly and confirm recovery.
11. Close and reopen the app and confirm the backend address persists.

## Troubleshooting

### The app stays on the connection screen

- Confirm the Mac backend is running.
- Open `http://MAC_TAILSCALE_IP:8000/api/status` from the Android browser.
- Confirm both devices are connected to the same Tailnet.
- Confirm macOS permits incoming connections to the backend.
- Re-enter the base URL without a trailing endpoint path.

### Wake word or recording does not work

- Confirm microphone permission is enabled in Android settings.
- Confirm no other application is holding exclusive microphone access.
- Check Android Logcat using the `BMO_WAKE` tag.
- Confirm the Mac's wake-word WebSocket endpoint is reachable.

### Camera requests fail

- Confirm camera permission is enabled.
- Confirm no other application is using the camera.
- Test normal chat to distinguish a camera problem from a backend problem.
- Confirm `moondream:latest` is installed on the Mac.

### Spotify does not connect

- Confirm the Spotify app is installed and signed in.
- Confirm the package name and signing SHA-1 are registered with Spotify.
- Confirm the redirect URI matches exactly.
- Confirm the Android source uses the correct Spotify client ID.
- Test search and playback separately because Mac search and Android playback use different connections.
- Check Android Logcat using the `BMO_SPOTIFY` tag.

### Backend changes are not visible

The WebView clears its cache at application startup. Restart the Android app after updating the backend. If needed, use the hidden developer interface to reload or reconfigure the backend.

## Release builds

Release signing is configured through user-level Gradle properties and is intentionally absent from the repository. A release build fails clearly when signing values are missing.

Do not commit:

- keystore files
- key aliases or passwords
- signing property files
- generated APKs

The signed release procedure and checksum verification are performed as part of the release checklist in `MAINTENANCE.md`.
