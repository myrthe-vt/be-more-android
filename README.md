# Be More Android / BMO 🤖

An embodied, local-first BMO assistant that uses an Android phone as the body and a Mac as the brain.

BMO is more than a chatbot with a character-themed interface. The Android device provides the face, microphone, speaker, camera, wake word, and physical presence, while the Mac runs the local language model, speech tools, integrations, memory, and FastAPI backend.

This project is designed around reusing hardware you already own. The reference setup uses an LG G7 ThinQ and a 2021 M1 Pro MacBook Pro, but compatible Android and macOS devices may work too.

> **Fan project:** BMO, Adventure Time, and related properties belong to their respective rights holders. This unofficial project is not affiliated with or endorsed by Cartoon Network or Warner Bros. Discovery.

## Features

- Local conversation with Ollama and `qwen2.5:7b`
- Local speech recognition with whisper.cpp
- Piper text-to-speech with a custom BMO voice
- Native Android wake-word detection and command recording
- Animated expressions, sound reactions, critters, and idle/daydream behavior
- Native Android camera, audio handling, touch controls, and volume overlay
- Spotify playback and now-playing information
- Google Calendar questions with read-only access
- Weather, web search, timers, reminders, and persistent memory
- Simple camera vision using `moondream:latest`
- Read-only homelab diagnostics
- Pronunciation editor and developer diagnostics
- Rotating backend and Android client-error logs

Optional integrations fail independently. BMO's core local conversation remains available when services such as Spotify, Calendar, weather, vision, or homelab diagnostics are not configured.

## How it works

| Android body | Mac brain |
|---|---|
| Full-screen BMO face | FastAPI backend |
| Wake-word detection | Ollama language and vision models |
| Microphone and command recording | whisper.cpp speech recognition |
| Camera capture | Piper text-to-speech |
| Spotify App Remote | Spotify Web API lookup |
| Touch and native device controls | Calendar, weather, search, memory, and timers |

The devices communicate over a trusted private network. The tested setup uses Tailscale and port `8000`.

## Requirements

### Mac brain

- macOS
- Homebrew
- Ollama
- Enough free space for Python dependencies and local AI models

The supported installer uses Python 3.13 and sets up Piper, whisper.cpp, required Python packages, and the Ollama models.

### Android body

- Android 8.0 or newer (`minSdk 26`)
- Microphone and optional camera access
- Network access to the Mac backend
- Spotify installed and a compatible Spotify account for playback features

The Android app is tested primarily on an LG G7 ThinQ in landscape orientation.

## Quick start

### 1. Set up the Mac

```bash
git clone https://github.com/myrthe-vt/be-more-android.git be-more-agent
cd be-more-agent
chmod +x setup-mac.sh start-bmo.sh
./setup-mac.sh
```

Start BMO:

```bash
./start-bmo.sh
```

On the Mac itself, the backend is available at `http://localhost:8000`. The Android device must use the Mac's reachable private LAN or Tailscale address instead of `localhost`.

### 2. Install the Android app

Download the signed APK from the repository's [Releases](https://github.com/myrthe-vt/be-more-android/releases) page, or build the Android client from source with Android Studio.

The phone may ask you to allow installation from the browser or file manager used to open the APK. After installation, configure the Mac backend address in BMO's developer screen.

See [Android setup](docs/ANDROID_SETUP.md) for device configuration, permissions, Spotify setup, source builds, and troubleshooting.

## Optional integrations

| Integration | Configuration | Behavior when unavailable |
|---|---|---|
| Spotify Web API | `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` | Music lookup reports that Spotify is unavailable |
| Google Calendar | Local OAuth credentials, token, and optional calendar selection | BMO reports that Calendar is not connected |
| Weather | No API key; requires outbound internet access | BMO reports that weather cannot be checked |
| Vision | Ollama with `moondream:latest` | Camera understanding reports that BMO's eyes are unavailable |
| Homelab diagnostics | Optional host values in `.env` | Remote diagnostics remain disabled |

Google Calendar uses the `calendar.readonly` OAuth scope. Homelab functionality is diagnostic-only and does not perform recovery or administrative actions.

Copy `.env.example` to `.env` when you need optional local configuration. Never commit the resulting `.env`, OAuth tokens, calendar data, private network details, or signing credentials.

## Android permissions

| Permission | Purpose |
|---|---|
| Microphone | Wake-word detection and spoken commands |
| Camera | Still-image capture for explicit vision requests |
| Internet | Communication with the Mac backend and integrations |
| Network state | Connection detection and backend recovery |
| Boot completed | Restoring the dedicated BMO experience after reboot |

Audio recordings and explicitly captured images are sent only to the backend address configured in the Android app.

## Diagnostics

Run the local diagnostic tool from the repository directory:

```bash
source venv/bin/activate
python bmo_diagnostics.py
```

It checks the backend, speech tools, models, disk space, optional integrations, log rotation, and recent backend or Android client errors. Runtime logs are written to `logs/bmo.log` with rotation enabled.

## Security and beta limitations

- BMO is an experimental self-hosted project, not a hardened public service.
- The backend has no user authentication and must remain on a trusted private LAN or Tailnet.
- The Android client supports HTTP for private-network deployments. HTTP is unencrypted, so use HTTPS when traffic could cross an untrusted network.
- Do not port-forward the backend or expose it directly to the public internet.
- The supported and tested installation path is macOS plus Android. Other platforms may require manual changes.
- Optional integrations require separate accounts, credentials, applications, or local services as described in the setup documentation.

## Documentation

- [Android setup](docs/ANDROID_SETUP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Maintenance and release checks](docs/MAINTENANCE.md)
- [Changelog](CHANGELOG.md)

## Project philosophy

Build around hardware you already own, keep the AI local where practical, and make the Android body feel like one small, expressive character rather than a remote control for a chatbot.

## Credits

- [brenpoly/be-more-agent](https://github.com/brenpoly/be-more-agent), the original project
- [moorew/be-more-hailo](https://github.com/moorew/be-more-hailo), Hailo fork and major inspiration
- OpenWakeWord for offline wake-word detection
- whisper.cpp for local speech recognition
- Piper for local text-to-speech
- Ollama for local language and vision model hosting

The custom BMO voice is based on voice work distributed with the original project. Preserve upstream copyright, attribution, and applicable third-party licensing requirements when redistributing this project or its assets.

## License

See [LICENSE](LICENSE) for the software license. The software license does not grant rights to third-party characters, trademarks, audio, artwork, models, or other bundled assets.

This repository is an unofficial, non-commercial fan project. BMO and Adventure Time remain trademarks and copyrights of their respective rights holders.
