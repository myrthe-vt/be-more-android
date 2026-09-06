#!/bin/bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

say_step() {
    echo
    echo -e "${YELLOW}==> $1${NC}"
}

say_ok() {
    echo -e "${GREEN}✓ $1${NC}"
}

say_warn() {
    echo -e "${YELLOW}! $1${NC}"
}

say_error() {
    echo -e "${RED}✗ $1${NC}"
}

echo -e "${GREEN}"
echo "╔══════════════════════════════════════╗"
echo "║          BMO macOS setup            ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"

# ------------------------------------------------------------
# Platform
# ------------------------------------------------------------

say_step "Checking macOS"

if [ "$(uname -s)" != "Darwin" ]; then
    say_error "This setup script is for macOS."
    exit 1
fi

say_ok "Running on macOS ($(uname -m))"

# ------------------------------------------------------------
# Homebrew
# ------------------------------------------------------------

say_step "Checking Homebrew"

if ! command -v brew >/dev/null 2>&1; then
    say_error "Homebrew is required but was not found."
    echo
    echo "Install Homebrew from:"
    echo "  https://brew.sh"
    echo
    echo "Then run ./setup-mac.sh again."
    exit 1
fi

say_ok "Homebrew found: $(command -v brew)"

# ------------------------------------------------------------
# Native dependencies
# ------------------------------------------------------------

say_step "Installing/checking native dependencies"

BREW_PACKAGES=(
    python@3.13
    portaudio
    cmake
    git
    ffmpeg
    wget
    espeak-ng
)

for package in "${BREW_PACKAGES[@]}"; do
    if brew list "$package" >/dev/null 2>&1; then
        say_ok "$package already installed"
    else
        echo "Installing $package..."
        brew install "$package"
    fi
done

# ------------------------------------------------------------
# Python 3.13
# ------------------------------------------------------------

say_step "Checking Python 3.13"

if command -v python3.13 >/dev/null 2>&1; then
    PYTHON="$(command -v python3.13)"
else
    PYTHON="$(brew --prefix python@3.13)/bin/python3.13"
fi

if [ ! -x "$PYTHON" ]; then
    say_error "Python 3.13 could not be located."
    exit 1
fi

say_ok "$("$PYTHON" --version)"

# ------------------------------------------------------------
# Virtual environment
# ------------------------------------------------------------

say_step "Setting up Python virtual environment"

if [ -d venv ]; then
    if [ -x venv/bin/python3 ]; then
        VENV_VERSION="$(venv/bin/python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"

        if [ "$VENV_VERSION" != "3.13" ]; then
            say_warn "Existing venv uses Python $VENV_VERSION, not 3.13."
            echo "Remove ./venv manually and rerun setup if you want it rebuilt."
            exit 1
        fi

        say_ok "Existing Python 3.13 venv found"
    else
        say_error "./venv exists but is not a usable Python environment."
        exit 1
    fi
else
    "$PYTHON" -m venv venv
    say_ok "Created Python 3.13 venv"
fi

source venv/bin/activate

python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt

say_ok "Python dependencies installed"

# ------------------------------------------------------------
# Piper
# ------------------------------------------------------------

say_step "Setting up Piper BMO voice"

mkdir -p piper

if [ ! -x venv/bin/piper ]; then
    say_error "piper-tts installed but venv/bin/piper was not created."
    exit 1
fi

ln -sfn "$BASE_DIR/venv/bin/piper" piper/piper

say_ok "Piper executable linked"

BMO_VOICE_RELEASE="v1.0-voice"
BMO_VOICE_URL="https://github.com/brenpoly/be-more-agent/releases/download/${BMO_VOICE_RELEASE}/bmo.onnx"
BMO_VOICE_JSON_URL="https://github.com/brenpoly/be-more-agent/releases/download/${BMO_VOICE_RELEASE}/bmo.onnx.json"

BMO_VOICE_SHA256="0b5a2f9e035f7798977320167f7b1bc5a5eeab4b15470d975b80fc56ae3bd8e0"
BMO_VOICE_JSON_SHA256="32e87407fd1a33b1282d6ddc80cc2af58eeec86d5c004062100732a8e996ca05"

if [ ! -f piper/bmo.onnx ]; then
    echo "Downloading BMO voice model..."
    curl -fL \
        "$BMO_VOICE_URL" \
        -o piper/bmo.onnx
else
    say_ok "BMO voice model already present"
fi

echo "${BMO_VOICE_SHA256}  piper/bmo.onnx" | shasum -a 256 -c - >/dev/null
say_ok "BMO voice model checksum verified"

if [ ! -f piper/bmo.onnx.json ]; then
    echo "Downloading BMO voice configuration..."
    curl -fL \
        "$BMO_VOICE_JSON_URL" \
        -o piper/bmo.onnx.json
else
    say_ok "BMO voice configuration already present"
fi

echo "${BMO_VOICE_JSON_SHA256}  piper/bmo.onnx.json" | shasum -a 256 -c - >/dev/null
say_ok "BMO voice configuration checksum verified"

# ------------------------------------------------------------
# whisper.cpp
# ------------------------------------------------------------

say_step "Setting up whisper.cpp"

if [ ! -d whisper.cpp/.git ]; then
    echo "Cloning whisper.cpp..."
    git clone \
        https://github.com/ggerganov/whisper.cpp.git \
        whisper.cpp
else
    say_ok "whisper.cpp repository already present"
fi

if [ ! -x whisper.cpp/build/bin/whisper-cli ]; then
    echo "Building whisper.cpp..."

    cmake \
        -S whisper.cpp \
        -B whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release

    cmake \
        --build whisper.cpp/build \
        --config Release \
        -j "$(sysctl -n hw.logicalcpu)"
else
    say_ok "whisper-cli already built"
fi

if [ ! -f whisper.cpp/models/ggml-base.en.bin ]; then
    echo "Downloading Whisper base.en model..."

    (
        cd whisper.cpp
        bash models/download-ggml-model.sh base.en
    )
else
    say_ok "Whisper base.en model already present"
fi

# ------------------------------------------------------------
# Wake word
# ------------------------------------------------------------

say_step "Checking BMO wake word"

if [ ! -f wakeword.onnx ]; then
    say_error "wakeword.onnx is missing."
    echo
    echo "This project uses its custom BMO wake-word model."
    echo "The setup script will NOT replace it with a generic model."
    echo
    echo "Restore wakeword.onnx from the repository and rerun setup."
    exit 1
fi

say_ok "Custom wakeword.onnx found"

# ------------------------------------------------------------
# Ollama
# ------------------------------------------------------------

say_step "Checking Ollama"

if ! command -v ollama >/dev/null 2>&1; then
    say_error "Ollama was not found."
    echo
    echo "Install Ollama, start it, then rerun setup:"
    echo "  https://ollama.com"
    exit 1
fi

say_ok "Ollama found: $(command -v ollama)"

if ! ollama list >/dev/null 2>&1; then
    say_error "Ollama is installed but its service is not reachable."
    echo
    echo "Start the Ollama app/service, then rerun setup."
    exit 1
fi

for model in \
    "qwen2.5:7b" \
    "moondream:latest"
do
    if ollama list | awk 'NR > 1 {print $1}' | grep -qx "$model"; then
        say_ok "$model already installed"
    else
        echo "Pulling $model..."
        ollama pull "$model"
    fi
done

# ------------------------------------------------------------
# Integration configuration
# ------------------------------------------------------------

say_step "Checking optional integrations"

if [ -f .env ] \
    && grep -Eq '^SPOTIFY_CLIENT_ID=.+' .env \
    && grep -Eq '^SPOTIFY_CLIENT_SECRET=.+' .env; then
    say_ok "Spotify configuration found"
else
    say_warn "Spotify Web API credentials not found in .env. Spotify catalog lookup will remain optional."
fi

if [ -f credentials.google-calendar.json ]; then
    say_ok "Google Calendar credentials found"
else
    say_warn "Google Calendar credentials not found."
fi

if [ -f token.google-calendar.json ]; then
    say_ok "Google Calendar token found"
else
    say_warn "Google Calendar has not been authorized yet."
fi

# ------------------------------------------------------------
# Sanity checks
# ------------------------------------------------------------

say_step "Running BMO sanity checks"

python -m py_compile \
    core/config.py \
    core/search.py \
    core/llm.py \
    core/stt.py \
    core/tts.py \
    core/calendar.py \
    core/weather.py \
    core/spotify.py \
    web_app.py \
    bmo_diagnostics.py

say_ok "Python syntax checks passed"

python <<'PY'
import core.config
import core.search
import core.llm
import web_app

print("✓ BMO application imports passed")
PY

# Diagnostics are informative. Optional integrations may report warnings,
# so don't make setup fail solely because diagnostics aren't fully green.
echo
python bmo_diagnostics.py || true

echo
echo -e "${GREEN}══════════════════════════════════════${NC}"
echo -e "${GREEN}BMO setup complete! 🎉${NC}"
echo -e "${GREEN}══════════════════════════════════════${NC}"
echo
echo "Start BMO with:"
echo
echo "  ./start-bmo.sh"
echo
