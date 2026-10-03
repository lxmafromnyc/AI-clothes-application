#!/usr/bin/env python3
"""
Fynd - the demo video's narration

Speaks the short lines the demo video is narrated with, the way a person
says what they are doing to someone sitting next to them, and writes them
to assets/demo/narration/ with a manifest that scripts/record-demo.js
reads to place each line against the recording.

How it is kept from sounding read:
  - no commas inside a line. The model turns a comma into a full stop
    and restart ("a black oversized hoodie... under eighty dollars");
    said out loud by a person, the line runs straight through.
  - each line at its own speed, all close to normal speech, so the lines
    do not share one even, recited rhythm.
  - every clip is checked: an internal gap longer than MAX_GAP seconds
    (a stretch well below the voice's own level) fails the run.
  - a little quieter than before, as somebody talking, not announcing.

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
MAX_GAP = 0.30          # seconds; anything longer reads as a recited pause
LOUDNESS = -20          # LUFS: talking, not announcing

# What is said, and when, in the order it happens on screen, with the
# speed each is said at. The keys are what scripts/record-demo.js asks for.
# The lines after the first search do not name a query, so the recorder can
# use whichever real queries the product source answers well.
LINES = [
    # typing the first search
    ('looking', 'I\u2019m looking for a black oversized hoodie under eighty dollars.', 1.00),
    # its results arrive
    ('options', 'And Fynd gives me a few different options to compare.', 1.02),
    # the pointer goes through them
    ('browse', 'I can look through them and open whichever one I like.', 0.97),
    # the retailer's page is on screen
    ('retailer', 'That takes me straight to the retailer.', 1.00),
    # starting the second search
    ('different', 'Let me try something completely different.', 1.03),
    # its results arrive
    ('results', 'And now I get a whole different set of results.', 0.99),
    # typing a brand or designer search
    ('brand', 'I can search for a specific brand too.', 1.02),
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

    manifest = {'voice': f'Kokoro v1.0 {VOICE}', 'loudness': LOUDNESS, 'lines': {}}
    failures = []
    for key, text, speed in LINES:
        # "Fynd" is said "find", and spelled that way for the voice: as
        # written, the model swallows its last consonant ("Fin gives…").
        # The caption keeps the name as it is written.
        audio = tts.generate(text.replace('Fynd', 'Find'), sid=SPEAKER_ID, speed=speed)
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, audio.samples, audio.sample_rate, subtype='PCM_16')
        target = os.path.join(OUT, f'{key}.wav')
        finish(raw.name, target)
        os.unlink(raw.name)
        gap = longest_gap(target)
        manifest['lines'][key] = {'text': text, 'file': f'{key}.wav', 'duration': round(duration(target), 3),
                                  'speed': speed, 'longestGap': round(gap, 2)}
        print(f'  {key:10s} {manifest["lines"][key]["duration"]:.2f}s  gap {gap:.2f}s  {text}')
        if gap > MAX_GAP:
            failures.append(f'{key}: a {gap:.2f}s pause inside the line')

    if failures:
        sys.exit('Lines with recited pauses — reword them:\n  ' + '\n  '.join(failures))

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
        '-af', f'{trim},loudnorm=I={LOUDNESS}:TP=-3:LRA=7,afade=t=in:d=0.02',
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target,
    ], check=True)


def longest_gap(path):
    """The longest stretch inside a line (not at its ends) where the level
    falls below a quarter of the voice's own median, in seconds."""
    import numpy as np
    import soundfile as sf
    a, sr = sf.read(path, dtype='float32')
    if a.ndim > 1:
        a = a.mean(1)
    n = int(sr * 0.02)
    k = len(a) // n
    rms = np.sqrt((a[:k * n].reshape(k, n) ** 2).mean(1))
    voiced = rms[rms > rms.max() * 0.05]
    quiet = rms < np.median(voiced) * 0.25
    first = int(np.argmax(~quiet))
    last = len(quiet) - int(np.argmax(~quiet[::-1]))
    longest = run = 0
    for q in quiet[first:last]:
        run = run + 1 if q else 0
        longest = max(longest, run)
    return longest * 0.02


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


if __name__ == '__main__':
    main()
