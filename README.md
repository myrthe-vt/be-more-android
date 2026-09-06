# Be More Agent / BMO 🤖

**An embodied, local-first BMO assistant using an Android phone as the body and a MacBook Pro as the brain.**

This fork of [brenpoly/be-more-agent](https://github.com/brenpoly/be-more-agent) is built around hardware I already owned: an **LG G7 ThinQ** for BMO's face, microphone, speaker, camera, wake word, and native Android controls, paired with a **2021 M1 Pro MacBook Pro** for local AI, speech, integrations, memory, and the FastAPI backend.

The goal is not a generic chatbot wearing a BMO face. It is one coherent little embodied character.

> **Fan project:** BMO, Adventure Time, and related properties belong to their respective rights holders. This project is not affiliated with or endorsed by Cartoon Network or Warner Bros. Discovery.

---

## ✨ Features

- **Local AI:** Ollama + `qwen2.5:7b`
- **Local speech recognition:** `whisper.cpp` with `ggml-base.en`
- **BMO voice:** Piper TTS with the custom BMO voice model
- **Wake word:** custom OpenWakeWord model
- **Android-native interaction:** wake word, command recording, audio state, camera, touch controls, and native/touch volume overlay
- **Spotify:** native Android App Remote + Mac Spotify Web API, with idle reconnect recovery
- **Google Calendar**
- **Weather**
- **Web search**
- **Timers & reminders**
- **Persistent memory**
- **Vision:** `moondream:latest`
- **Idle/daydream personality**
- **Reactive expressions, critters, now-playing display, charging/unplugging reactions, and sound personality**
- **Hidden developer/debug screen** with runtime controls and diagnostics
- **Pronunciation editor** for speech fixes without editing code
- **Diagnostics & rotating logs**
- **Tailscale-friendly Mac ↔ Android architecture**

---

## 🧠 What runs where

| Component | Where it runs | Implementation |
|---|---|---|
| BMO face / UI | LG G7 ThinQ | Android WebView |
| Wake word | Android | OpenWakeWord |
| Command recording | Android | Native Android audio |
| Spotify playback control | Android | Spotify App Remote |
| Camera | Android | Native Android |
| Audio activity detection / volume UI | Android | `AudioManager` + native overlay |
| Developer/debug screen | Android | Hidden native/WebView debug UI |
| Backend | MacBook Pro | FastAPI / Uvicorn |
| LLM | MacBook Pro | Ollama, `qwen2.5:7b` |
| Vision | MacBook Pro | Ollama, `moondream:latest` |
| STT | MacBook Pro | whisper.cpp, `ggml-base.en` |
| TTS | MacBook Pro | Piper |
| Calendar | MacBook Pro | Google Calendar API |
| Spotify metadata / Web API | MacBook Pro | Spotify Web API |
| Weather / search / memory / timers | MacBook Pro | Python backend |
| Networking | Both | Tailscale |

### Hardware used

| Role | Hardware |
|---|---|
| **Body** | LG G7 ThinQ, Android 8+ |
| **Brain** | 2021 M1 Pro MacBook Pro, 16 GB RAM |
| **Network** | Tailscale |
| **Extra hardware required** | None beyond devices already owned |

---

## 🚀 Quick start

### Mac

Requirements:

- macOS
- Homebrew
- Ollama

Clone the repository:

```bash
git clone https://github.com/myrthe-vt/be-more-android.git be-more-agent
cd be-more-agent
```

Run the installer:

```bash
chmod +x setup-mac.sh
./setup-mac.sh
```

Start BMO:

```bash
./start-bmo.sh
```

The backend runs on:

```text
http://0.0.0.0:8000
```

`setup-mac.sh` checks or installs the supported Mac stack, including Python 3.13, required Homebrew packages, the Python environment, Piper, whisper.cpp, and the required Ollama models.

### Android

The Android client lives in the `android/` directory of this repository.

Current build configuration:

| Setting | Value |
|---|---|
| Package | `com.sapphi.bmo` |
| minSdk | 26 |
| targetSdk | 37 |
| compileSdk | 37 |
| Java | 11 |
| Orientation | Landscape |

Build a debug APK from Windows:

```powershell
cd C:\GitHub\be-more-android\android
.\gradlew.bat assembleDebug
```

The Android client currently reaches the Mac backend over **Tailscale HTTP**. Cleartext traffic is therefore intentionally enabled for this configuration.

---

## 🔧 Mac stack

| Service | Current configuration |
|---|---|
| Python | 3.13 |
| Backend | FastAPI + Uvicorn |
| LLM | `qwen2.5:7b` |
| Vision | `moondream:latest` |
| STT | whisper.cpp `ggml-base.en` |
| TTS | Piper + custom `bmo.onnx` |
| Wake model | `wakeword.onnx` |
| Port | `8000` |

### Ollama models

```bash
ollama pull qwen2.5:7b
ollama pull moondream:latest
```

The setup script checks these automatically.

---

## 🎵 Integrations

| Integration | Notes |
|---|---|
| **Spotify** | Native Android App Remote for playback + Mac Web API support |
| **Google Calendar** | OAuth credentials stored locally and ignored by Git |
| **Weather** | Backend weather integration |
| **Web search** | Current search backend uses `ddgs` |
| **Vision** | Android camera + Mac `moondream` processing |
| **Homelab diagnostics** | Read-only diagnostic flows |

### Spotify

Supported native controls include:

- play
- pause
- resume
- next
- previous
- shuffle
- repeat
- now-playing metadata
- playback progress

Spotify App Remote recovery is handled without a permanent keepalive: BMO reconnects on resume or on demand when a stale connection is detected. A one-shot pending command retry lets the command that discovered the stale connection continue automatically after reconnect.

BMO also checks Android's local audio state so the **jamming** expression only appears when music is actually audible.

### Google Calendar

These files stay local and are ignored by Git:

```text
credentials.google-calendar.json
token.google-calendar.json
calendar_selection.json
```

---

## 📂 Project structure

```text
be-more-agent/
├── web_app.py                  # FastAPI backend
├── bmo_diagnostics.py          # Diagnostic CLI
├── setup-mac.sh                # Supported Mac installer
├── start-bmo.sh                # Normal launcher
├── wakeword.onnx               # Custom wake-word model
├── requirements.txt
├── core/
│   ├── config.py
│   ├── llm.py
│   ├── stt.py
│   ├── tts.py
│   ├── search.py
│   ├── calendar.py
│   ├── weather.py
│   ├── spotify.py
│   ├── diagnostics.py
│   └── logging_setup.py
├── static/
│   └── face.js                 # WebView face / interaction logic
├── piper/                      # Local TTS runtime + model (ignored)
├── whisper.cpp/                # Local STT build + model (ignored)
├── logs/                       # Rotating runtime logs (ignored)
└── venv/                       # Python environment (ignored)
```

---

## 🩺 Diagnostics

Run:

```bash
source venv/bin/activate
python bmo_diagnostics.py
```

Or query:

```text
GET /api/diagnostics
```

Diagnostics currently cover:

- Ollama/backend
- Piper binary and model
- whisper.cpp binary and model
- disk space
- Calendar
- Spotify
- weather
- vision model
- log rotation
- latest backend error
- latest frontend/native Android client error

Runtime logs are written to:

```text
logs/bmo.log
```

with **5 MB rotation and 3 backups**.

---

## 🔐 Local config & secrets

Local secrets and runtime assets are intentionally excluded from Git.

Examples:

```text
.env
.env.spotify
credentials.google-calendar.json
token.google-calendar.json
calendar_selection.json
logs/
piper/
whisper.cpp/
venv/
```

`wakeword.onnx` is intentionally tracked.

Do not commit OAuth tokens, API secrets, personal calendar data, private network details, or machine-specific credentials.

---

## 🌐 Networking

The Android device and MacBook communicate over **Tailscale**:

```text
LG G7 ThinQ
     │
     │ Tailscale
     ▼
MacBook Pro
FastAPI :8000
```

The backend listens on all interfaces so it can be reached through the Mac's Tailscale address.

The current setup uses HTTP inside the Tailnet. Do not expose the backend directly to the public internet without adding appropriate authentication and transport security.

---

## ⚠️ Known limitations

- **HTTP transport:** Android currently talks to the Mac over Tailscale HTTP rather than HTTPS.
- **Hardware-specific fork:** This branch is tested around the Mac + Android architecture above. Some optional compatibility code from earlier hardware targets remains but is not part of the supported Mac install path.
- **Android release build:** signed release APK work is still part of the initial beta release process.

---

## ✅ Project status

| Area | Status |
|---|---|
| Core interaction | ✅ |
| Wake word | ✅ |
| Android resilience | ✅ |
| Memory | ✅ |
| Timers & reminders | ✅ |
| Web search | ✅ |
| Weather | ✅ |
| Google Calendar | ✅ |
| Spotify | ✅ |
| Spotify idle reconnect / one-shot retry | ✅ |
| Vision | ✅ |
| Developer/debug screen | ✅ |
| Pronunciation editor | ✅ |
| Diagnostics / logging | ✅ |
| Mac install/start path | ✅ |
| README / repo cleanup | ✅ |
| Signed Android APK | ⏳ |
| Tagged beta release | ⏳ |

The initial public release should be considered **experimental / beta**.

---

## 💚 Project philosophy

> **"I LOVE THIS, but I don't want to invest money into it, so I'll use hardware I already own and build around that."**

The project deliberately favors reusing existing hardware over buying extra parts, while still trying to make BMO feel like one physical, expressive character.

---

## 🙏 Credits

- **Original project:** [brenpoly/be-more-agent](https://github.com/brenpoly/be-more-agent)
- **Hailo fork / major inspiration:** [moorew/be-more-hailo](https://github.com/moorew/be-more-hailo)
- **Custom BMO voice:** based on the voice work distributed with the original project
- **OpenWakeWord:** offline wake-word detection
- **whisper.cpp:** local speech recognition
- **Piper:** local text-to-speech
- **Ollama:** local LLM / vision model runtime

Please preserve upstream copyright, attribution, and license notices when redistributing modified work.

---

## 📄 License

See [`LICENSE`](LICENSE) for the software license and preserve any applicable upstream attribution or asset licensing requirements.

This repository is an unofficial, non-commercial fan project. BMO and Adventure Time are trademarks and copyrights of their respective rights holders.
