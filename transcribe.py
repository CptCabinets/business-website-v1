#!/usr/bin/env python3
"""Local Whisper transcription script — called from the Telegram bot."""

import sys
from faster_whisper import WhisperModel

if len(sys.argv) < 2:
    print("Usage: transcribe.py <audio_file>", file=sys.stderr)
    sys.exit(1)

audio_path = sys.argv[1]

# Use tiny model — fast, low memory, good enough for clear voice commands
# First run will download the model (~40MB) to ~/.cache/huggingface/
model = WhisperModel("tiny", device="cpu", compute_type="int8")

segments, _ = model.transcribe(audio_path, language="en")
text = " ".join(seg.text.strip() for seg in segments)
print(text)
