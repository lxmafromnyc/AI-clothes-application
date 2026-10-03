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
MAX_GAP = 0.25          # seconds; anything longer reads as a recited pause
LOUDNESS = -18          # LUFS: the voice, always above the music bed (-29)

# What is said, in the order it happens on screen: (key, what the voice
# is given, what the caption says, speed). The keys are what
# scripts/record-demo.js asks for. Only the first search is named out
# loud; the others are narrated without naming the query, so the
# recorder can use whichever real query the product source answers well.
LINES = [
    # the homepage, before anything is typed
    ('hook', 'Ever know exactly what you want but not where to find it?',
     'Ever know exactly what you want, but not where to find it?', 1.00),
    # into the search box
    ('describe', 'Instead of checking a bunch of stores I can just describe it.',
     'Instead of checking a bunch of stores, I can just describe it.', 1.00),
    # typing the first search
    ('hoodie', 'I need a black oversized hoodie but I don\u2019t want to spend more than eighty dollars.',
     'I need a black oversized hoodie, but I don\u2019t want to spend more than $80.', 1.02),
    # looking through what came back
    ('stores', 'And these are all coming from different stores.',
     'And these are all coming from different stores.', 0.98),
    # on the first retailer page
    ('retailer', 'Then I can open the exact product at the store selling it.',
     'Then I can open the exact product at the store selling it.', 1.00),
    # changing one detail of the request
    ('refine', 'And I can change the details without rebuilding a bunch of filters.',
     'And I can change the details without rebuilding a bunch of filters.', 1.02),
    # starting something completely different
    ('different', 'Or maybe I\u2019m looking for something completely different.',
     'Or maybe I\u2019m looking for something completely different.', 1.00),
    # a designer
    ('designer', 'I can even get more specific and search for a particular designer.',
     'I can even get more specific and search for a particular designer.', 1.02),
    # a request with several details at once
    ('sentence', 'I don\u2019t need any filters for this. I can say the whole thing in one sentence.',
     'I don\u2019t need any filters for this. I can say the whole thing in one sentence.', 1.02),
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
    recognizer = whisper()
    for key, text, caption, speed in LINES:
        if ',' in text:
            failures.append(f'{key}: a comma inside the spoken line becomes a pause; reword it')
        # "Fynd" is said "find", and spelled that way for the voice: as
        # written, the model swallows its last consonant ("Fin gives…").
        # The caption keeps the name as it is written.
        audio = tts.generate(text.replace('Fynd', 'Find'), sid=SPEAKER_ID, speed=speed)
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, audio.samples, audio.sample_rate, subtype='PCM_16')
        target = os.path.join(OUT, f'{key}.wav')
        finish(raw.name, target)
        os.unlink(raw.name)
        level = exact_level(target, LOUDNESS)
        gap = longest_gap(target)
        manifest['lines'][key] = {'text': text, 'caption': caption, 'file': f'{key}.wav', 'duration': round(duration(target), 3),
                                  'speed': speed, 'longestGap': round(gap, 2), 'lufs': round(level, 1)}
        print(f'  {key:10s} {manifest["lines"][key]["duration"]:.2f}s  {level:.1f} LUFS  gap {gap:.2f}s  {text}')
        if recognizer:
            heard = recognizer(target)
            print(f'  {"":10s} heard: {heard}')
            if words(heard) != words(text.replace('Fynd', 'Find')):
                failures.append(f'{key}: transcribed as "{heard}"')
        if gap > MAX_GAP:
            failures.append(f'{key}: a {gap:.2f}s pause inside the line')
        if abs(level - LOUDNESS) > 0.5:
            failures.append(f'{key}: {level:.1f} LUFS, not {LOUDNESS}')

    if failures:
        sys.exit('The narration is not usable:\n  ' + '\n  '.join(failures))

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


def measure(path):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    import re
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])


def exact_level(path, target):
    """loudnorm's single pass undershoots on a clip this short. Measure it
    and apply the exact gain; the few consonant peaks that would then pass
    -1.5 dBFS are caught by a fast, gentle limiter (nothing else is
    compressed). Measured again and nudged until it is within 0.2 LU."""
    for _ in range(4):
        lufs = measure(path)
        if abs(lufs - target) <= 0.2:
            break
        tmp = path + '.tmp.wav'
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', path,
                        '-af', f'volume={target - lufs:.2f}dB,alimiter=limit=0.84:attack=3:release=60:level=disabled',
                        '-ar', '48000', '-c:a', 'pcm_s16le', tmp], check=True)
        os.replace(tmp, path)
    return measure(path)


def words(s):
    import re
    s = s.lower().replace('\u2019', "'").replace('$80', 'eighty dollars')
    return re.sub(r"[^a-z' ]+", ' ', s).split()


def whisper():
    """With WHISPER_DIR set to a sherpa-onnx Whisper model, every clip is
    transcribed back and must say what it was asked to say."""
    d = os.environ.get('WHISPER_DIR')
    if not d:
        return None
    import sherpa_onnx
    import soundfile as sf
    name = os.path.basename(d.rstrip('/')).replace('sherpa-onnx-whisper-', '')
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=os.path.join(d, f'{name}-encoder.int8.onnx'), decoder=os.path.join(d, f'{name}-decoder.int8.onnx'),
        tokens=os.path.join(d, f'{name}-tokens.txt'), language='en', task='transcribe', num_threads=4)

    def transcribe(path):
        a, sr = sf.read(path, dtype='float32')
        st = rec.create_stream()
        st.accept_waveform(sr, a)
        rec.decode_stream(st)
        return st.result.text.strip()
    return transcribe


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


if __name__ == '__main__':
    main()
