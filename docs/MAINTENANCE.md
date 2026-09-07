# Maintenance Guide

This guide covers routine maintenance, diagnostics, testing, configuration, and release preparation for the supported Mac and Android deployment.

## Principles

- Keep core chat usable when optional integrations are unavailable.
- Keep credentials and machine-specific configuration outside Git.
- Preserve homelab integrations as read-only.
- Run regression tests after routing or action changes.
- Inspect generated diffs before committing.
- Prefer small, reversible changes close to a release.
- Back up persistent state before migrations or destructive maintenance.

## Mac environment

The supported environment uses Python 3.13 and the repository-local `venv`.

```bash
cd ~/be-more-agent
source venv/bin/activate
python --version
```

If the environment is missing, run `./setup-mac.sh`. The setup script checks dependencies, creates the environment, installs packages, prepares speech tools, and checks Ollama models.

## Starting and updating

Start BMO with:

```bash
cd ~/be-more-agent
./start-bmo.sh
```

Before updating, run `git status`. For a clean checkout:

```bash
git pull --ff-only
./setup-mac.sh
```

Using `--ff-only` prevents an unexpected merge commit.

## Dependencies and models

Install runtime and test dependencies with:

```bash
source venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
```

Check required Ollama models with `ollama list`. Restore them with:

```bash
ollama pull qwen2.5:7b
ollama pull moondream:latest
```

## Diagnostics and logs

Run diagnostics with:

```bash
source venv/bin/activate
python bmo_diagnostics.py
```

The backend also provides `GET /api/diagnostics`.

Logs are stored in `logs/bmo.log` with 5 MB rotation and three backups. Inspect them with `tail -n 100 logs/bmo.log` or follow them with `tail -f logs/bmo.log`.

Before sharing logs, check for usernames, paths, private addresses, Tailnet names, calendar information, queries, tokens, and client identifiers.

## Configuration and secrets

Create local configuration with:

```bash
cp .env.example .env
```

These files must remain local:

```text
.env
.env.spotify
credentials.google-calendar.json
token.google-calendar.json
calendar_selection.json
```

Never commit API secrets, OAuth data, personal calendar identifiers, private addresses, Tailscale names, absolute machine paths, production logs, or Android signing material.

Confirm sensitive files are untracked with:

```bash
git ls-files .env .env.spotify credentials.google-calendar.json \
  token.google-calendar.json calendar_selection.json
```

A correct result prints nothing.

## Tests

Run the complete unit suite with:

```bash
source venv/bin/activate
python -m pytest tests/unit -q
```

Run the release-critical group with:

```bash
python -m pytest \
  tests/unit/test_routing.py \
  tests/unit/test_actions.py \
  tests/unit/test_sanitize_messages.py \
  tests/unit/test_transcript_cleaning.py \
  -q
```

The validated v0.9.0 release-candidate result is `91 passed`.

FastAPI `on_event` deprecation warnings do not currently indicate failure. Migrating to lifespan handlers is deferred maintenance that requires dedicated regression testing.

Tests outside `tests/unit/` may require special hardware, models, services, or compatibility targets.

## Routing changes

When changing deterministic routing:

1. Add or update a focused test.
2. Test phrases that should match.
3. Test nearby phrases that must not match.
4. Confirm unavailable integrations fail safely.
5. Run the complete routing group.
6. Perform a spoken-device smoke test for Android-facing changes.

Prefer narrow phrases and explicit exclusions because broad keyword matching can intercept normal conversation.

## Android maintenance

The Android project lives in `android/`.

Build a debug APK on Windows with:

```powershell
cd C:\GitHub\be-more-android\android
.\gradlew.bat assembleDebug
```

Before a release build:

- confirm the backend URL
- confirm signing configuration is not tracked
- inspect permissions
- test microphone and camera denial
- test backend-unavailable recovery
- test wake-word rearming
- test Spotify reconnect behavior
- test the back button
- test a cold start

Never commit keystores, signing passwords, or generated signing configuration.

## Integration maintenance

Google Calendar uses read-only OAuth access. If authorization becomes invalid, preserve any token needed for diagnosis, remove the invalid local token, authorize again, confirm calendar selection, and test a read-only query.

Spotify uses the Web API on Mac for search and App Remote on Android for playback. Diagnose search and playback separately. Confirm the Spotify app is signed in, Android redirect configuration matches, Mac credentials exist locally, and stale connections recover.

Remote homelab checks use optional `BMO_HOMELAB_PRIMARY_HOST` and `BMO_HOMELAB_MEDIA_HOST` values. Leave them blank to disable remote checks. New homelab functions must not restart services, change containers, delete files, install packages, or write remote configuration.

## Persistence backups

Before changing persistence formats, back up memory, timers, pronunciation overrides, and local integration selections outside the repository. Test restores using a copy.

## Repository hygiene

Before every release:

```bash
git status --short
git diff --check
git ls-files
```

Look for backups, APKs, environments, logs, secrets, private configuration, obsolete scripts, and machine-specific files.

Large tracked assets such as the wake-word model, Android library, images, and sounds may be intentional. Do not remove them solely because they are large.

## Release checklist

- [ ] Working tree is clean.
- [ ] `main` matches `origin/main`.
- [ ] Unit tests pass.
- [ ] Android debug build succeeds.
- [ ] Signed release APK builds successfully.
- [ ] Final Android and Mac smoke test passes.
- [ ] Secrets and private configuration are absent.
- [ ] Documentation matches current behavior.
- [ ] APK SHA-256 is recorded.
- [ ] The release commit is final.
- [ ] The `v0.9.0` tag points to the final commit.
- [ ] GitHub release is marked beta or experimental.
- [ ] The signed APK and checksum are attached.

## Deferred maintenance

- migrate FastAPI startup from deprecated `on_event` hooks to lifespan handlers
- add GitHub Actions
- add automatic signed APK builds
- add Android-to-Mac protocol versioning
- add documented memory backup and restore tooling
- validate installation on additional clean machines and accounts
