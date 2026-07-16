#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate
pip install --upgrade pip
echo "Installing dependencies (torch is a large download, ~2-3 GB)..."
pip install -r requirements.txt

MODEL_DIR="pretrained_models/Spark-TTS-0.5B"
if [ -f "$MODEL_DIR/LLM/model.safetensors" ]; then
  echo "Spark-TTS-0.5B weights already installed at $MODEL_DIR"
else
  echo "Downloading Spark-TTS-0.5B weights (~4 GB)..."
  mkdir -p "$MODEL_DIR"
  huggingface-cli download SparkAudio/Spark-TTS-0.5B --local-dir "$MODEL_DIR"
fi

echo ""
echo "voice-service is ready. Start it with:"
echo "  voice-service/venv/bin/python voice-service/main.py"
