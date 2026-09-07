# Changelog

All notable changes to this project are documented here. The project is experimental, and compatibility may change before v1.0.0.

## [Unreleased]

### Planned

- Automated signed Android builds.
- Explicit Android-to-Mac protocol versioning.
- Documented BMO memory backup and restore tooling.
- FastAPI lifespan migration.
- Additional fresh-machine and fresh-account validation.

## [0.9.0] - 2026-09-07

First public beta of the supported Mac and Android architecture.

### Added

- Android WebView body with fullscreen BMO interface.
- Native Android wake-word detection and command recording.
- Native camera capture and local `moondream:latest` vision.
- Native Spotify App Remote playback and Mac Spotify Web API lookup.
- Now-playing metadata, progress, shuffle, repeat, and transport controls.
- Local playback detection for accurate jamming expressions.
- Read-only Google Calendar queries.
- Weather, web search, memory, timers, and reminders.
- Read-only homelab diagnostics and health summaries.
- Local Ollama, whisper.cpp, and Piper processing.
- Idle personality, expressions, sound cues, critters, and charging reactions.
- Native and touch volume display.
- Hidden developer and diagnostics interface.
- Pronunciation editor and rotating logs.
- Runtime Android backend configuration.
- Mac setup and one-command startup scripts.
- Complete Android setup and troubleshooting guide.
- GitHub Actions checks for Python unit tests and unsigned Android debug builds.
- Regression tests for critical routing and actions.

### Changed

- Consolidated the Mac backend and Android client into one repository.
- Made the Mac and Android split the primary supported architecture.
- Moved machine-specific settings and secrets into ignored configuration.
- Reduced the public repository to supported source, assets, tests, and setup files.
- Hardened the Android manifest, WebView, lifecycle, and back-button behavior.
- Improved recovery from backend, network, WebView, and Spotify interruptions.
- Improved setup checks for Python, dependencies, speech tools, models, and configuration.
- Aligned Android compile and target SDK settings with the available API 36 toolchain.
- Improved deterministic routing and public release documentation.

### Fixed

- Fresh Mac setup failures caused by missing dependencies or configuration.
- Missing OpenWakeWord feature models and BMO voice installation.
- Spotify connections becoming stale after idle periods.
- Loss of the first Spotify command when reconnecting.
- Unsafe Spotify search failures when credentials, connectivity, or results were unavailable.
- Incorrect jamming state when Spotify was connected but not audible.
- Android backend addresses being tied to one machine.
- WebView recovery, lifecycle, back-navigation, routing, and transcript-cleaning edge cases.

### Security

- Removed personal data, credentials, tokens, private network details, calendar identifiers, and machine paths from tracked configuration.
- Added a public-safe `.env.example`.
- Kept OAuth data, secrets, logs, runtimes, environments, and signing material out of Git.
- Documented the trusted-network requirement for HTTP.
- Confirmed homelab features remain read-only.
- Documented Android permission behavior.
- Added controlled failure behavior for optional services.

### Validation

- Critical routing and action suite: 91 tests passed.
- Legacy, backup, tracked-file, and large-file sweeps completed.
- Signed APK and final device smoke testing remain required before publication.
