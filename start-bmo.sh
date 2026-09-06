#!/bin/bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

if [ ! -x venv/bin/python3 ]; then
    echo "BMO virtual environment is missing."
    echo
    echo "Run:"
    echo "  ./setup-mac.sh"
    exit 1
fi

if [ ! -f wakeword.onnx ]; then
    echo "BMO wakeword.onnx is missing."
    exit 1
fi

if [ ! -f piper/bmo.onnx ]; then
    echo "BMO Piper voice model is missing."
    echo
    echo "Run:"
    echo "  ./setup-mac.sh"
    exit 1
fi

if [ ! -x whisper.cpp/build/bin/whisper-cli ]; then
    echo "whisper.cpp is not built."
    echo
    echo "Run:"
    echo "  ./setup-mac.sh"
    exit 1
fi

source venv/bin/activate

HOST="${BMO_HOST:-0.0.0.0}"
PORT="${BMO_PORT:-8000}"

echo "Starting BMO..."
echo "Backend: http://$HOST:$PORT"
echo "Press Ctrl+C to stop."
echo

exec python -m uvicorn \
    web_app:app \
    --host "$HOST" \
    --port "$PORT"
