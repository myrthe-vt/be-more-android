# Architecture

Be More Agent is an embodied, local-first BMO assistant. An Android phone provides the body and user-facing experience, while a Mac provides local AI inference, speech processing, integrations, memory, and orchestration.

This document describes the supported Mac and Android architecture for the v0.9.0 beta.

## Design goals

- Reuse hardware that is already available.
- Keep AI inference and personal data local where practical.
- Present one coherent character rather than disconnected tools.
- Keep the Android body responsive when optional backend services fail.
- Keep homelab integration diagnostic and read-only.
- Store secrets and machine-specific configuration outside Git.
- Fail safely when an optional integration is unavailable.

## System overview

The supported deployment has two primary components:

| Component | Responsibilities |
|---|---|
| Android body | WebView face, wake word, command recording, camera, Spotify App Remote, device state, and recovery |
| Mac brain | FastAPI, Ollama, whisper.cpp, Piper, memory, timers, integrations, routing, and diagnostics |

The devices communicate over a trusted private network. The current deployment uses Tailscale and HTTP on port `8000`.

## Android body

The Android client lives in `android/` and is designed to behave like a dedicated appliance.

Its responsibilities include:

- displaying BMO's face in a fullscreen WebView
- detecting the custom wake word locally
- recording spoken commands
- uploading audio to the Mac for transcription
- capturing still images for explicit vision requests
- controlling playback through Spotify App Remote
- reporting local playback, battery, charging, and connectivity state
- recovering from backend, WebView, network, and Spotify interruptions
- providing hidden developer controls and diagnostics

### Native and WebView boundary

`MainActivity.kt` owns hardware-facing and lifecycle-sensitive behavior. The WebView owns presentation, expressions, transcripts, status text, sound cues, critters, and now-playing information.

The layers communicate through JavaScript callbacks and Android bridge methods. Native events include recording state, transcripts, errors, vision results, Spotify state, charging state, and backend connectivity.

This separation keeps Android permissions, audio, camera, Spotify, and lifecycle recovery out of the browser presentation code.

### Android resilience

The Android application includes:

- backend health checks and retry handling
- WebView watchdog behavior
- connectivity-change recovery
- wake-word rearming
- Spotify reconnection on resume or demand
- one-shot retry for a command that encounters a stale Spotify connection
- safe behavior when the backend or Spotify is unavailable
- explicit back-button handling

### Android permissions

| Permission | Purpose |
|---|---|
| `RECORD_AUDIO` | Wake-word detection and spoken command recording |
| `CAMERA` | Still-image capture for explicit vision requests |
| `INTERNET` | Mac backend and network integrations |
| `ACCESS_NETWORK_STATE` | Connectivity detection and recovery |
| `RECEIVE_BOOT_COMPLETED` | Restoring Android-side behavior after reboot |

Calendar access is handled by the Mac backend. Spotify playback uses Spotify App Remote and does not require a separate Android runtime permission.

## Mac brain

The main backend entry point is `web_app.py`.

The backend coordinates deterministic intent routing, local language-model responses, speech processing, persistent memory, timers, weather, Calendar, web search, Spotify lookup, vision, homelab diagnostics, and client state.

### Core modules

| Module | Responsibility |
|---|---|
| `core/config.py` | Runtime configuration |
| `core/llm.py` | Ollama conversation and model handling |
| `core/stt.py` | whisper.cpp speech recognition |
| `core/tts.py` | Piper speech generation |
| `core/search.py` | Web search |
| `core/calendar.py` | Read-only Google Calendar queries |
| `core/weather.py` | Weather and forecast lookup |
| `core/spotify.py` | Spotify Web API search and metadata |
| `core/timers.py` | Timers and reminders |
| `core/diagnostics.py` | Local runtime diagnostics |
| `core/homelab.py` | Read-only homelab data gathering |
| `core/homelab_health.py` | Homelab health interpretation |
| `core/homelab_router.py` | Homelab question routing |
| `core/logging_setup.py` | Rotating application logs |

### Local model stack

| Function | Runtime |
|---|---|
| Text generation | Ollama with `qwen2.5:7b` |
| Vision | Ollama with `moondream:latest` |
| Speech recognition | whisper.cpp with `ggml-base.en` |
| Speech generation | Piper with the BMO voice model |
| Wake word | OpenWakeWord on Android |

## Request flows

### Spoken interaction

1. Android detects the wake word locally.
2. Android records and uploads the spoken request.
3. The Mac transcribes it with whisper.cpp.
4. The transcript is returned to the WebView.
5. Deterministic routing handles supported actions before LLM fallback.
6. The backend generates a response and Piper audio.
7. Android displays and plays the response.
8. Wake-word detection is rearmed.

### Spotify interaction

Spotify responsibilities are split deliberately:

- The Mac Spotify Web API searches for tracks, artists, albums, and metadata.
- Android Spotify App Remote performs native playback.

If App Remote is stale, Android reconnects and retries the pending command once. Spotify is optional, and unavailable credentials, connectivity, or results produce a controlled failure.

### Vision interaction

1. A routed request asks BMO to look at something.
2. Android requests camera permission if necessary.
3. Android captures and resizes a still image.
4. The Mac processes it with `moondream:latest`.
5. The result returns to the Android presentation layer.

Vision failure remains isolated from normal conversation.

### Homelab diagnostics

Homelab flows are read-only by design. They can inspect reachability, service state, container state, and storage health, then explain what appears to need attention.

They do not restart services, alter containers, delete data, or automatically repair systems.

## Presentation layer

The presentation layer is primarily implemented in `templates/index.html`, `static/app.js`, `static/face.html`, `static/face.js`, `static/face.css`, and `static/style.css`.

It manages expressions, interaction states, idle behavior, now-playing information, critters, sound personality, charging reactions, transcripts, status messages, pronunciation editing, and diagnostic UI.

## Persistence and configuration

Runtime state may include BMO memory, timers, pronunciation overrides, OAuth tokens, selected calendars, logs, temporary audio, and downloaded models.

Machine-specific state and credentials are ignored by Git. Tracked defaults must never contain personal tokens, private addresses, calendar identifiers, or local filesystem paths.

## Networking and trust boundary

The current Android deployment permits HTTP because communication occurs inside a trusted Tailnet. HTTP does not provide transport encryption by itself.

Do not expose the backend directly to the public internet without HTTPS, authentication, authorization, request controls, and rate limiting.

## Failure isolation

| Failure | Expected behavior |
|---|---|
| Spotify credentials missing | Spotify search reports unavailable |
| Spotify App Remote disconnected | Android reconnects or reports unavailable |
| Calendar not configured | Calendar reports not connected |
| Weather unavailable | Weather reports it cannot be checked |
| Vision model missing | Vision reports that BMO's eyes are unavailable |
| Homelab hosts unconfigured | Remote checks remain disabled |
| Backend unreachable | Android displays connection state and retries |
| Speech recognition failure | Android reports the error and rearms listening |

A missing optional integration must not prevent the core backend from starting.

## Testing boundaries

The portable regression suite lives in `tests/unit/` and covers routing, action extraction, transcript cleanup, sanitization, timers, memory isolation, and response cleanup.

Live-pipeline, hardware, Android instrumentation, and model-performance tests are separate because they require external services, models, devices, or credentials.

## Supported deployment

The v0.9.0 beta is primarily tested with macOS on Apple Silicon, Python 3.13, a 2021 M1 Pro MacBook Pro, Android 8 or newer, an LG G7 ThinQ, and Tailscale.

Other environments may work but are not yet part of the validated installation path.
