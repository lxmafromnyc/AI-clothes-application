#!/usr/bin/env python3
"""
Fynd - the demo video's narration

Speaks the four short lines the demo video is narrated with, in a calm
conversational voice, and writes them to assets/demo/narration/ with a
manifest that scripts/record-demo.js reads to place each line against the
recording.

The voice is Kokoro v1.0 (af_heart), a neural text-to-speech model that
runs offline through sherpa-onnx. The clips are committed, so recording
the demo never needs this script or the model; it is only run again when
a line changes.

Usage:
    pip install sherpa-onnx soundfile numpy
    # the model: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
    #   kokoro-multi-lang-v1_0.tar.bz2, unpacked anywhere
    KOKORO_DIR=/path/to/kokoro-multi-lang-v1_0 python3 scripts/demo-narration.py

Needs ffmpeg for the finishing pass: leading and trailing silence trimmed,
and every line brought to the same loudness, so no line is louder than
the one before it.
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'assets', 'demo', 'narration')

VOICE = 'af_heart'
SPEAKER_ID = 3          # af_heart in kokoro-multi-lang-v1_0
SPEED = 0.94            # a touch under 1: unhurried, not slow

# What is said, and when, in the order it happens on screen. The keys are
# what scripts/record-demo.js asks for. "options-one" stands in for
# "options" when every result comes from the same retailer, so the line
# never claims something the screen does not show.
LINES = [
    ('looking', 'I\u2019m looking for a black oversized hoodie, under eighty dollars.'),
    ('options', 'Fynd gives me several options, from different retailers.'),
    ('options-one', 'Fynd gives me several options.'),
    ('compare', 'I can compare them, and open the ones I like.'),
    ('choose', 'So I can search naturally, and choose where I want to buy.'),
]


def main():
    try:
        import sherpa_onnx
        import soundfile as sf
    except ImportError:
        sys.exit('Needs sherpa-onnx and soundfile: pip install sherpa-onnx soundfile numpy')

    model_dir = os.environ.get('KOKORO_DIR')
    if not model_dir or not os.path.exists(os.path.join(model_dir, 'model.onnx')):
        sys.exit('Set KOKORO_DIR to an unpacked kokoro-multi-lang-v1_0 directory.')

    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(model_dir, 'model.onnx'),
                voices=os.path.join(model_dir, 'voices.bin'),
                tokens=os.path.join(model_dir, 'tokens.txt'),
                data_dir=os.path.join(model_dir, 'espeak-ng-data'),
                lexicon=','.join(os.path.join(model_dir, f) for f in ('lexicon-us-en.txt',)),
                lang='en-us',
            ),
            num_threads=4,
        ),
        max_num_sentences=1,
    )
    tts = sherpa_onnx.OfflineTts(config)
    os.makedirs(OUT, exist_ok=True)

    manifest = {'voice': f'Kokoro v1.0 {VOICE}', 'speed': SPEED, 'lines': {}}
    for key, text in LINES:
        # "Fynd" is said "find", and spelled that way for the voice: as
        # written, the model swallows its last consonant ("Fin gives…").
        # The caption keeps the name as it is written.
        audio = tts.generate(text.replace('Fynd', 'Find'), sid=SPEAKER_ID, speed=SPEED)
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, audio.samples, audio.sample_rate, subtype='PCM_16')
        target = os.path.join(OUT, f'{key}.wav')
        finish(raw.name, target)
        os.unlink(raw.name)
        manifest['lines'][key] = {'text': text, 'file': f'{key}.wav', 'duration': round(duration(target), 3)}
        print(f'  {key:10s} {manifest["lines"][key]["duration"]:.2f}s  {text}')

    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {os.path.relpath(OUT, REPO)}/manifest.json')


def finish(source, target):
    """Trim the silence at both ends, then even out the loudness. 48 kHz
    mono, which is what the video's audio track is encoded from."""
    trim = ('silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,'
            'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse')
    subprocess.run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
        '-af', f'{trim},loudnorm=I=-18:TP=-2:LRA=7,afade=t=in:d=0.02',
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target,
    ], check=True)


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


if __name__ == '__main__':
    main()
