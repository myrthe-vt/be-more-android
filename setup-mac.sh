#!/bin/bash

set -e

# ==========================================================
# Be More Agent - macOS Setup Script
# Optimized for Apple Silicon (M1/M2/M3)
# ==========================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🤖 Be More Agent macOS Setup${NC}"

# ----------------------------------------------------------
# 1. Check Homebrew
# ----------------------------------------------------------

echo -e "${YELLOW}[1/7] Checking Homebrew...${NC}"

if ! command -v brew >/dev/null 2>&1; then
    echo -e "${RED}❌ Homebrew not found.${NC}"
    echo "Install from:"
    echo "https://brew.sh"
    exit 1
fi

# ----------------------------------------------------------
# 2. Install Dependencies
# ----------------------------------------------------------

echo -e "${YELLOW}[2/7] Installing macOS dependencies...${NC}"

brew install portaudio cmake git espeak-ng wget

# ----------------------------------------------------------
# 3. Create Project Folders
# ----------------------------------------------------------

echo -e "${YELLOW}[3/7] Creating folders...${NC}"

mkdir -p piper
mkdir -p voices

mkdir -p sounds/greeting_sounds
mkdir -p sounds/thinking_sounds
mkdir -p sounds/ack_sounds
mkdir -p sounds/error_sounds

mkdir -p faces/idle
mkdir -p faces/listening
mkdir -p faces/thinking
mkdir -p faces/speaking
mkdir -p faces/error
mkdir -p faces/warmup

# ----------------------------------------------------------
# 4. Download Voice Models
# ----------------------------------------------------------

echo -e "${YELLOW}[4/7] Downloading Piper voices...${NC}"

mkdir -p piper

cd piper

wget -nc \
-O en_GB-semaine-medium.onnx \
https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/semaine/medium/en_GB-semaine-medium.onnx

wget -nc \
-O en_GB-semaine-medium.onnx.json \
https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/semaine/medium/en_GB-semaine-medium.onnx.json

cd ..

# ----------------------------------------------------------
# 5. Optional BMO Voice
# ----------------------------------------------------------

echo -e "${YELLOW}[5/7] Downloading BMO voice...${NC}"

curl -L \
-o voices/bmo-custom.onnx \
https://github.com/brenpoly/be-more-agent/releases/latest/download/bmo.onnx \
|| true

curl -L \
-o voices/bmo-custom.onnx.json \
https://github.com/brenpoly/be-more-agent/releases/latest/download/bmo.onnx.json \
|| true

# ----------------------------------------------------------
# 6. Python Environment
# ----------------------------------------------------------

echo -e "${YELLOW}[6/7] Setting up Python environment...${NC}"

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate

pip install --upgrade pip setuptools wheel

pip install --force-reinstall --no-cache-dir sounddevice

pip install -r requirements.txt

# ----------------------------------------------------------
# 7. Ollama Models
# ----------------------------------------------------------

echo -e "${YELLOW}[7/7] Checking Ollama...${NC}"

if command -v ollama >/dev/null 2>&1; then

    echo "Pulling language model..."
    ollama pull qwen2.5:7b

    echo "Pulling vision model..."
    ollama pull moondream

else
    echo -e "${RED}❌ Ollama not found.${NC}"
    echo "Install:"
    echo "https://ollama.com"
fi

# ----------------------------------------------------------
# Wake Word
# ----------------------------------------------------------

if [ ! -f "wakeword.onnx" ]; then

    echo -e "${YELLOW}Downloading wake word model...${NC}"

    curl -L \
    -o wakeword.onnx \
    https://github.com/dscripka/openWakeWord/raw/main/openwakeword/resources/models/hey_jarvis_v0.1.onnx

fi

# ----------------------------------------------------------

echo ""
echo -e "${GREEN}✨ Setup complete!${NC}"
echo ""

echo "Activate environment:"
echo "source venv/bin/activate"

echo ""
echo "Run agent:"
echo "python agent.py"
