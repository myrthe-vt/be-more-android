# Be More Agent / BMO

An embodied BMO-inspired assistant built around hardware I already owned.

This fork uses an **Android phone as BMO's body** and a **MacBook Pro as BMO's brain**. The Android device handles the physical interaction layer, while the Mac runs speech recognition, local AI, text-to-speech, integrations, diagnostics, and the main FastAPI backend.

The goal is not to make a generic chatbot with a BMO face. The goal is to make BMO feel like one coherent embodied character.

> This is an unofficial fan project. BMO, Adventure Time, and related properties belong to their respective rights holders.

---

## Architecture

### Android phone = body

The current BMO body is an **LG G7 ThinQ**.

It handles:

- fullscreen BMO face
- touch interaction
- microphone access
- speaker output
- native Android wake-word detection
- native command recording
- native Spotify App Remote control
- Android audio-state detection
- camera access
- developer/debug UI
- WebView hosting the BMO interface

The Android application package is:

```text
com.sapphi.bmo
```

Current Android requirements:

- Android 8 or newer
- minSdk 26
- landscape-oriented device

### MacBook Pro = brain

The current backend runs on a:

```text
2021 M1 Pro MacBook Pro
16 GB RAM
macOS
```

The Mac handles:

- FastAPI backend
- deterministic intent routing
- local LLM inference through Ollama
- whisper.cpp speech-to-text
- Piper text-to-speech
- custom BMO wake-word model
- memory
- timers and reminders
- web search
- Google Calendar
- weather
- Spotify Web API
- homelab diagnostics
- simple vision processing
- logging and client-error collection

The backend listens on:

```text
0.0.0.0:8000
```

The Android device normally reaches it over **Tailscale**.

### WebView = presentation layer

The web frontend handles:

- BMO face animations
- expressions
- conversation transcripts
- status text
- audio playback
- critter overlays
- now-playing information
- developer/debug interface

Native Android functionality communicates with this presentation layer where appropriate.

---

## AI stack

### Main text model

BMO currently uses:

```text
qwen2.5:7b
```

through Ollama.

### Vision model

Simple vision uses:

```text
moondream:latest
```

through Ollama.

### Speech-to-text

Speech recognition uses:

```text
whisper.cpp
ggml-base.en.bin
```

### Text-to-speech

Speech output uses Piper with the custom BMO voice:

```text
piper/bmo.onnx
piper/bmo.onnx.json
```

### Wake word

The custom tracked wake-word model is:

```text
wakeword.onnx
```

---

# Mac installation

## Requirements

The supported setup is macOS with Homebrew.

The installer checks or installs the required dependencies, including:

- Python 3.13
- PortAudio
- CMake
- Git
- FFmpeg
- wget
- espeak-ng

It also prepares:

- Python virtual environment
- Python dependencies
- Piper
- whisper.cpp
- Whisper base.en model
- Ollama models
- required directories and links

## First-time setup

Clone the repository and enter it:

```bash
git clone <your-repository-url>
cd be-more-agent
```

Then run:

```bash
chmod +x setup-mac.sh
./setup-mac.sh
```

The setup script is designed to be safe to run again. Existing models and dependencies should not be unnecessarily downloaded again.

The supported installer for this branch is **`setup-mac.sh`**.

There is intentionally no generic `setup.sh`. The old Raspberry Pi installer was removed because it no longer represented this Mac + Android architecture.

## Starting BMO

For normal use:

```bash
cd ~/be-more-agent
./start-bmo.sh
```

This starts the FastAPI application with Uvicorn:

```text
http://0.0.0.0:8000
```

Stop it with `Ctrl+C`.

---

# Optional services

BMO can use several external or local services.

The core assistant can still start when optional configuration is unavailable, although the corresponding features will not work.

## Ollama

Required for local LLM inference.

Models currently used:

```bash
ollama pull qwen2.5:7b
ollama pull moondream:latest
```

`setup-mac.sh` checks these automatically.

## Google Calendar

Calendar integration uses the Google Calendar API.

Local credentials and tokens are intentionally excluded from Git.

Ignored files include:

```text
credentials.google-calendar.json
token.google-calendar.json
calendar_selection.json
```

Do not commit personal Calendar credentials or tokens.

## Spotify

Spotify support is split between the Mac and Android layers.

The Mac provides Spotify Web API functionality.

The Android application uses Spotify App Remote for native playback control and player-state information.

Supported controls include:

- play
- pause
- resume
- next
- previous
- currently playing metadata
- playback progress

BMO also uses Android's local audio state so its jamming expression only appears when music is actually audible on the device.

Spotify configuration is stored outside Git.

## Weather

Weather support runs from the Mac backend.

The diagnostics command can confirm whether it is available.

## Vision

Simple vision requests use:

```text
moondream:latest
```

through Ollama.

The normal Mac vision path does **not** require OpenCV.

Some optional compatibility code for other hardware remains in the project and is intentionally not part of the normal Mac dependency set.

---

# Android application

The Android client currently lives in a separate repository.

Example local path on Windows:

```text
C:\GitHub\be-more-android\android
```

Current Android configuration:

```text
namespace/applicationId: com.sapphi.bmo
minSdk: 26
targetSdk: 37
compileSdk: 37
versionCode: 1
versionName: 1.0
Java: 11
```

## Building the debug APK

From PowerShell:

```powershell
cd C:\GitHub\be-more-android\android
.\gradlew.bat assembleDebug
```

The Android app currently permits cleartext HTTP because the BMO backend is reached through Tailscale using HTTP.

Do not disable cleartext traffic without also changing the backend transport.

---

# Networking

The Mac and Android device are intended to communicate over **Tailscale**.

Typical arrangement:

```text
LG G7 ThinQ
    |
    | Tailscale
    |
MacBook Pro
FastAPI :8000
```

The Mac FastAPI server listens on all interfaces so the phone can reach it through the Mac's Tailscale address.

Do not expose the BMO backend directly to the public internet without adding appropriate authentication and transport security.

---

# Diagnostics

BMO includes built-in diagnostics for checking the supported Mac environment.

Run:

```bash
cd ~/be-more-agent
source venv/bin/activate
python bmo_diagnostics.py
```

Diagnostics currently check:

- backend / Ollama
- Piper executable
- Piper model
- whisper.cpp executable
- Whisper model
- disk state
- Calendar configuration
- Spotify availability
- weather availability
- vision model
- logging
- latest backend error
- latest frontend/native Android client error

The backend also exposes:

```text
GET /api/diagnostics
```

---

# Logging

Runtime logs are stored under:

```text
logs/
```

The main rotating log is:

```text
logs/bmo.log
```

Rotation currently uses:

```text
5 MB per file
3 backups
```

Frontend JavaScript errors, unhandled promise rejections, and selected Android client errors can also be forwarded to the Mac diagnostics system.

Diagnostic reporting is designed not to interrupt normal BMO operation if logging itself fails.

---

# Local configuration and secrets

The repository intentionally ignores local secrets, runtime data, downloaded models, and generated files.

Examples include:

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

The custom:

```text
wakeword.onnx
```

is tracked by Git.

Never commit API secrets, OAuth credentials, personal Calendar information, private network addresses, or device-specific personal configuration.

---

# Important project files

```text
web_app.py
core/config.py
core/llm.py
core/search.py
core/stt.py
core/tts.py
core/calendar.py
core/weather.py
core/spotify.py
core/diagnostics.py
core/logging_setup.py
bmo_diagnostics.py
static/face.js
requirements.txt
setup-mac.sh
start-bmo.sh
```

---

# Troubleshooting

## BMO will not start

Run:

```bash
./setup-mac.sh
```

and then:

```bash
source venv/bin/activate
python bmo_diagnostics.py
```

Fix any failed required checks before starting BMO again.

## Ollama is unavailable

Check:

```bash
ollama list
```

BMO currently expects:

```text
qwen2.5:7b
moondream:latest
```

A client/server Ollama version warning has been observed without affecting BMO operation.

Treat it as a problem only if Ollama requests actually begin failing.

## Android cannot reach BMO

Check that:

1. BMO is running on the Mac.
2. The Mac and phone are connected to Tailscale.
3. The Android client is configured to reach the correct Mac address.
4. Port 8000 is reachable.
5. `/api/status` responds successfully.

## Speech recognition problems

Confirm that these exist:

```text
whisper.cpp/build/bin/whisper-cli
whisper.cpp/models/ggml-base.en.bin
```

Then run:

```bash
python bmo_diagnostics.py
```

## BMO voice problems

Confirm:

```text
piper/bmo.onnx
piper/bmo.onnx.json
piper/piper
```

The installer creates the Piper executable link from the Python virtual environment.

---

# Known limitations

## Spotify idle reconnection

Spotify App Remote can occasionally stop responding after the Android device or Spotify has been idle for a while.

A reconnect-on-demand or reconnect-on-resume strategy may be added.

Constant keepalive polling is intentionally avoided unless it proves necessary.

## Network transport

The current Android-to-Mac connection uses HTTP over Tailscale rather than HTTPS.

## Hardware scope

This branch is built and tested around the specific Mac + Android architecture described above.

There is still some optional compatibility code inherited from earlier hardware targets. That code should not be assumed to be part of the supported Mac installation path.

---

# Project status

The main v1 functionality currently includes:

- [x] Core BMO interaction
- [x] Wake word
- [x] Android resilience
- [x] Memory
- [x] Timers and reminders
- [x] Web search
- [x] Homelab diagnostics
- [x] Idle/daydream personality
- [x] BMO sound personality
- [x] Weather
- [x] Google Calendar
- [x] Spotify integration
- [x] Simple vision
- [x] Reliable diagnostics and logging
- [x] Mac installation/start path
- [ ] Final repository cleanup
- [ ] Signed Android release APK
- [ ] Tagged v1 release

The current release target should be considered experimental while hardware-specific assumptions and remaining edge cases are documented.

---

# Project philosophy

> "I LOVE THIS, but I don't want to invest money into it, so I'll use hardware I already own and build around that."

This project deliberately favors repurposing existing hardware over adding unnecessary new hardware.

Feature creep before a stable v1 is intentionally discouraged.

---

# Credits

This project is based on and inspired by the original **Be More Agent** project and related community work.

Thanks to the original creators and contributors whose work made this fork possible.

Please preserve upstream copyright and license notices when redistributing or modifying their work.
