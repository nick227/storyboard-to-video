#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required (whisperx.load_audio shells out to it) but was not found on PATH." >&2
  exit 1
fi

if [ ! -d venv ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate
pip install --upgrade pip
echo "Installing dependencies (torch is a large download, ~2-3 GB)..."
pip install -r requirements.txt

echo "Pre-downloading the WhisperX align model and NLTK sentence-tokenizer data..."
python3 -c "
import whisperx, nltk
whisperx.load_align_model(language_code='en', device='cpu')
nltk.download('punkt_tab', quiet=True)
"

echo ""
echo "alignment-service is ready. Start it with:"
echo "  alignment-service/venv/bin/python alignment-service/main.py"
