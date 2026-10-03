#!/usr/bin/env python3
"""
Fynd - the demo video's narration

Speaks the short lines the demo video is narrated with, in a calm
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

# What is said, and when, in the order it happens on screen. The keys are
# what scripts/record-demo.js asks for. "found-one" stands in for "found"
# when every result comes from the same retailer, so the line is never
# claiming something the screen does not show.
#
# Only the first line names a request. The later searches can fall back
# to another request when the first one does not come back with enough
# real, verifiable products (see SEARCHES in scripts/record-demo.js), so
# their lines say what kind of problem it is, and the box shows the words.
#
# `text` is the caption, word for word. `say` is how it is spoken: one or
# more sentences, each with its own pace, and the pause between them.
# A sentence is never cut in two — a TTS voice drops its pitch at the
# end of anything it is given, and a half-sentence that ends falling is
# the surest way to sound synthetic. What changes from line to line is
# the pace, which is what keeps seven lines from sharing one cadence:
# the opener unhurried, the observations a touch quicker, the close
# slowing into its last words.
#
# "Fynd" is spoken as "Find": the voice has no entry for "Fynd" and
# guesses at it, and the brand is said like the word.
LINES = [
    {'key': 'looking', 'text': 'I’m looking for a black oversized hoodie, under eighty dollars.',
     'say': [('I’m looking for a black oversized hoodie, under eighty dollars.', 0.95)]},
    {'key': 'found', 'text': 'Fynd finds matching products from different retailers.',
     'say': [('Find finds matching products from different retailers.', 0.99)]},
    {'key': 'found-one', 'text': 'Fynd finds matching products.',
     'say': [('Find finds matching products.', 0.97)]},
    {'key': 'open', 'text': 'And I can open the product directly at the retailer.',
     'say': [('And I can open the product directly at the retailer.', 0.97)]},
    {'key': 'different', 'text': 'Something completely different works the same way.',
     'say': [('Something completely different works the same way.', 0.95)]},
    {'key': 'specific', 'text': 'Even something specific that’s hard to find.',
     'say': [('Even something specific that’s hard to find.', 0.92)]},
    {'key': 'particular', 'text': 'Or the exact style and color I have in mind.',
     'say': [('Or the exact style and color I have in mind.', 0.96)]},
    {'key': 'close', 'text': 'No more searching store after store. Describe it, and Fynd finds it.',
     'say': [('No more searching store after store.', 1.0), 0.32, ('Describe it, and Find finds it.', 0.9)]},
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

    import numpy as np
    manifest = {'voice': f'Kokoro v1.0 {VOICE}', 'lines': {}}
    for line in LINES:
        rate = None
        pieces = []
        for part in line['say']:
            if isinstance(part, float):
                pieces.append(('pause', part))
                continue
            words, speed = part
            audio = tts.generate(words, sid=SPEAKER_ID, speed=speed)
            rate = audio.sample_rate
            pieces.append(('speech', np.asarray(audio.samples, dtype=np.float32)))
        joined = []
        for i, (kind, value) in enumerate(pieces):
            if kind == 'pause':
                joined.append(np.zeros(int(rate * value), dtype=np.float32))
            else:
                # each sentence trimmed of the model's own silence, so the
                # pause between two is exactly the one written above
                joined.append(trim(value, rate, keep_start=i == 0, keep_end=i == len(pieces) - 1))
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, np.concatenate(joined), rate, subtype='PCM_24')
        key = line['key']
        target = os.path.join(OUT, f'{key}.wav')
        finish(raw.name, target)
        os.unlink(raw.name)
        manifest['lines'][key] = {
            'text': line['text'],
            'spoken': ' '.join(p[0] for p in line['say'] if not isinstance(p, float)),
            'pace': [p[1] for p in line['say'] if not isinstance(p, float)],
            'file': f'{key}.wav',
            'duration': round(duration(target), 3)
        }
        print(f'  {key:10s} {manifest["lines"][key]["duration"]:.2f}s  {line["text"]}')

    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {os.path.relpath(OUT, REPO)}/manifest.json')


def trim(samples, rate, keep_start, keep_end):
    """The model's leading and trailing silence, cut back to 30 ms
    wherever two sentences meet."""
    import numpy as np
    loud = np.flatnonzero(np.abs(samples) > 10 ** (-45 / 20))
    if not len(loud):
        return samples
    pad = int(rate * 0.03)
    start = 0 if keep_start else max(0, loud[0] - pad)
    end = len(samples) if keep_end else min(len(samples), loud[-1] + pad)
    return samples[start:end]


def finish(source, target):
    """How a voice recorded close to a good microphone in a quiet room is
    finished, and no more than that:

      high-pass at 70 Hz        rumble nobody can hear but a limiter can
      +1.5 dB around 180 Hz     the body the model leaves thin
      -2 dB around 3.2 kHz      its slight glassiness, never a dip deep
                                enough to dull the words
      de-esser                  the s and t the model sharpens
      2:1 above -24 dB          gentle, slow enough to keep every
                                syllable's own shape: evenness, not
                                loudness
      silence trimmed, then every line brought to the same loudness
      (-19 LUFS), so no line is louder than the one before it

    48 kHz mono, 24-bit: the mix is made from these and nothing is lost
    before it."""
    trim_silence = ('silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,'
                    'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse')
    chain = ','.join([
        'aresample=48000:resampler=soxr',
        'highpass=f=70:poles=2',
        'equalizer=f=180:t=q:w=0.9:g=1.5',
        'equalizer=f=3200:t=q:w=1.4:g=-2',
        'deesser=i=0.35:m=0.5:f=0.5:s=o',
        'acompressor=threshold=-24dB:ratio=2:attack=12:release=180:knee=6:makeup=1',
        trim_silence,
        'afade=t=in:d=0.015',
        'areverse,afade=t=in:d=0.04,areverse',
    ])
    shaped = target + '.shaped.wav'
    subprocess.run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
        '-af', chain, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', shaped,
    ], check=True)
    # One fixed gain to the line's loudness, measured — never a loudness
    # filter riding the gain inside a three-second line. Then the few
    # stressed vowels that stand 16 dB or more above the rest of the
    # line are held at 13 dB above it (-6 dBFS) by a look-ahead limiter,
    # which only ever touches those peaks; a voice with a steady
    # peak-to-loudness ratio sits in a mix without being pushed into the
    # master limiter. The limiter takes a fraction of a dB off the line,
    # so it is measured again and set back exactly.
    limited = target + '.limited.wav'
    gain = LINE_LUFS - loudness(shaped)
    subprocess.run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', shaped,
        '-af', f'volume={gain:.2f}dB,alimiter=limit=0.5:attack=4:release=80:level=false:latency=true',
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', limited,
    ], check=True)
    trim_db = LINE_LUFS - loudness(limited)
    subprocess.run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', limited,
        '-af', f'volume={trim_db:.2f}dB', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', target,
    ], check=True)
    os.unlink(shaped)
    os.unlink(limited)


LINE_LUFS = -19.0


def loudness(path):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    import re
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


if __name__ == '__main__':
    main()
