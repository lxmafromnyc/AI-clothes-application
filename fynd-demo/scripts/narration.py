#!/usr/bin/env python3
"""
Fynd film - the voice

Speaks the film's five lines with the same voice and the same finishing
as the recorder's narration (scripts/demo-narration.py at the repo root:
Kokoro v1.0 af_heart, no commas inside a line, silence trimmed; here at -18 LUFS,
no recited pauses), and writes them to public/audio/narration/ with
voice.json: each line's length in frames, which the film places against
the locked timeline (src/data/timeline.ts VOICE_AT). A line too long for
its scene fails here, before anything is rendered.

If WHISPER_DIR points at a sherpa-onnx Whisper model, every clip is
transcribed back and must say what it was asked to say.

    KOKORO_DIR=/path/to/kokoro-multi-lang-v1_0 python3 scripts/narration.py
    (optional) WHISPER_DIR=/path/to/sherpa-onnx-whisper-base.en
"""

import importlib.util
import json
import math
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True  # importing the recorder's helpers leaves no cache in scripts/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
OUT = os.path.join(ROOT, 'public', 'audio', 'narration')
FPS = 30

# the recorder's narration helpers: one way of finishing a line, not two
spec = importlib.util.spec_from_file_location('demo_narration', os.path.join(REPO, 'scripts', 'demo-narration.py'))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
# the film's voice sits at -18 LUFS, above a music bed at about -27
shared.LOUDNESS = -18
# and no pause inside a line longer than this (after "Looking for" above all)
MAX_GAP = 0.25

# id, what is said, what the caption reads, speed, the most frames the
# line may take (from its start to the end of its scene, with a margin)
LINES = [
    ('looking', 'Looking for a black oversized hoodie under eighty dollars?',
     'Looking for a black oversized hoodie under $80?', 1.00, 150 - 40 - 6),
    ('understands', 'Fynd understands what you\u2019re looking for.',
     'Fynd understands what you\u2019re looking for.', 1.00, 255 - 160 - 6),
    ('brings', 'And it brings back matching products from different retailers.',
     'And it brings back matching products from different retailers.', 0.98, 495 - 262 - 6),
    ('compare', 'I can compare them and open the one I like.',
     'I can compare them and open the one I like.', 0.97, 765 - 522 - 6),
    ('straight', 'And that takes me straight to the retailer.',
     'And that takes me straight to the retailer.', 1.00, 960 - 790 - 6),
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

    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(model_dir, 'model.onnx'),
                voices=os.path.join(model_dir, 'voices.bin'),
                tokens=os.path.join(model_dir, 'tokens.txt'),
                data_dir=os.path.join(model_dir, 'espeak-ng-data'),
                lexicon=os.path.join(model_dir, 'lexicon-us-en.txt'),
                lang='en-us',
            ),
            num_threads=4,
        ),
        max_num_sentences=1,
    ))
    recognizer = whisper()
    os.makedirs(OUT, exist_ok=True)

    voice, failures = [], []
    for key, text, caption, speed, budget in LINES:
        if ',' in text:
            failures.append(f'{key}: a comma inside the line becomes a pause; reword it')
        # "Fynd" is spelled "Find" for the voice only (as written, the model
        # says "Fin"); the caption keeps the name
        audio = tts.generate(text.replace('Fynd', 'Find'), sid=shared.SPEAKER_ID, speed=speed)
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, audio.samples, audio.sample_rate, subtype='PCM_16')
        target = os.path.join(OUT, f'{key}.wav')
        shared.finish(raw.name, target)
        os.unlink(raw.name)

        seconds = shared.duration(target)
        frames = math.ceil(seconds * FPS)
        gap = shared.longest_gap(target)
        heard = recognizer(target) if recognizer else None
        print(f'  {key:12s} {seconds:.2f}s ({frames} frames, budget {budget})  gap {gap:.2f}s  {text}')
        if heard is not None:
            print(f'  {"":12s} heard: {heard}')
            if words(heard) != words(text.replace('Fynd', 'Find')):
                failures.append(f'{key}: transcribed as "{heard}"')
        if gap > MAX_GAP:
            failures.append(f'{key}: a {gap:.2f}s pause inside the line')
        if frames > budget:
            failures.append(f'{key}: {frames} frames, longer than its {budget}-frame place in the timeline')
        voice.append({'id': key, 'file': f'audio/narration/{key}.wav', 'durationInFrames': frames,
                      'seconds': round(seconds, 3), 'caption': caption, 'spoken': text, 'speed': speed,
                      'longestGap': round(gap, 2)})

    if failures:
        sys.exit('The narration is not usable:\n  ' + '\n  '.join(failures))
    with open(os.path.join(OUT, 'voice.json'), 'w') as f:
        json.dump(voice, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {os.path.relpath(os.path.join(OUT, "voice.json"), ROOT)}')


def words(s):
    s = s.lower().replace('’', "'").replace('$80', 'eighty dollars')
    return re.sub(r"[^a-z' ]+", ' ', s).split()


def whisper():
    d = os.environ.get('WHISPER_DIR')
    if not d:
        return None
    import sherpa_onnx
    import soundfile as sf
    name = os.path.basename(d.rstrip('/')).replace('sherpa-onnx-whisper-', '')
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=os.path.join(d, f'{name}-encoder.int8.onnx'),
        decoder=os.path.join(d, f'{name}-decoder.int8.onnx'),
        tokens=os.path.join(d, f'{name}-tokens.txt'),
        language='en', task='transcribe', num_threads=4)

    def transcribe(path):
        a, sr = sf.read(path, dtype='float32')
        s = rec.create_stream()
        s.accept_waveform(sr, a)
        rec.decode_stream(s)
        return s.result.text.strip()
    return transcribe


if __name__ == '__main__':
    main()
