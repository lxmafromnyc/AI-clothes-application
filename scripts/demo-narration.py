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

The film's lines are given a delivery as well as words: each its own
register, range, accented words and way of ending, and a breath where a
new thought starts (scripts/demo_voice.py). Where every word falls in
the finished clip is written to the manifest, so the film can set its
type on the word and the score can leave room for it.

Usage:
    pip install sherpa-onnx soundfile numpy scipy pyworld librosa
    # the voice: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
    #   kokoro-multi-lang-v1_0.tar.bz2, unpacked anywhere
    # the word aligner: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
    #   sherpa-onnx-zipformer-small-en-2023-06-26.tar.bz2, unpacked anywhere
    KOKORO_DIR=/path/to/kokoro-multi-lang-v1_0 ASR_DIR=/path/to/sherpa-onnx-zipformer-small-en-2023-06-26 \
        python3 scripts/demo-narration.py --only=hook,describe,look,pick,switch,rare,there,exact,finale

    --only=a,b   only those lines; every other line in the manifest is
                 kept exactly as it is (a line spoken again is never
                 byte-identical to the last time)

Needs ffmpeg for the finishing pass: leading and trailing silence trimmed,
and every line brought to the same loudness, so no line is louder than
the one before it.
"""

import json
import os
import re
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

    # The film (scripts/demo-film.js): someone showing a friend something
    # they have found useful. Curious at first, a lift when the products
    # appear, easy about the store, a little playful at the jacket, leaning
    # in for the hard one, pleased when it turns up, sure at the end. Each
    # line gets its own delivery (scripts/demo_voice.py):
    #
    #   shift    its register, in semitones, against the voice's own
    #   range    how much its melody moves
    #   accents  the words it leans on: pitch, level, a touch more time
    #   end      how it finishes: a question rises, a line that leads on
    #            lifts, a conclusion settles
    #   (every line also has a soft ceiling: no syllable is pushed more
    #   than about 5.5 semitones over its register)
    #   breath   a short inhale before a line that starts a new thought
    #
    # A part's 'caption' is what the captions show for it; the line's
    # 'text' is the whole caption.
    {'key': 'hook', 'text': 'Ever know exactly what you want, but not where to find it?', 'breath': 0.28,
     'say': [('Ever know exactly what you want, but not where to find it?', 0.96,
              {'shift': 0.4, 'range': 1.2, 'end': ('question', 3.0), 'end_span': 0.5,
               'accents': {'exactly': {'st': 2.0, 'stretch': 1.1, 'db': 1.2}, 'where': {'st': 1.6, 'db': 1.0}}})]},
    {'key': 'describe', 'text': 'So, with Fynd? You just describe it.',
     'say': [('So, with Find? You just describe it.', 1.0,
              {'shift': 0.0, 'range': 1.28, 'end': ('fall', 0.6),
               'accents': {'Find': {'st': 1.2}, 'describe': {'st': 2.0, 'stretch': 1.08, 'db': 1.0}}})]},
    {'key': 'look', 'text': 'And look — it searches real stores, and brings back what actually matches.', 'breath': 0.22,
     'say': [('And look! It searches real stores, and brings back what actually matches.', 1.04,
              {'shift': 1.6, 'range': 1.35, 'end': ('lift', 1.2),
               'accents': {'look': {'st': 2.6, 'stretch': 1.12, 'db': 1.5}, 'real': {'st': 1.8, 'db': 1.0},
                           'actually': {'st': 2.0, 'stretch': 1.06, 'db': 1.0}}})]},
    {'key': 'pick', 'text': 'Pick one, and you’re right there at the store.',
     'say': [('Pick one, and you’re right there at the store.', 1.0,
              {'shift': 0.5, 'range': 1.25, 'end': ('fall', 0.8),
               'accents': {'one': {'st': 1.5}, 'right': {'st': 1.8, 'db': 1.0}}})]},
    {'key': 'switch', 'text': 'Something totally different? Same idea.',
     'say': [('Something totally different?', 1.04,
              {'shift': 0.3, 'range': 1.4, 'end': ('rise', 1.6),
               'accents': {'totally': {'st': 2.6, 'stretch': 1.12, 'db': 1.5}}}),
             0.16,
             ('Same idea.', 1.0,
              {'shift': 0.3, 'range': 1.3, 'end': ('lift', 0.8), 'accents': {'Same': {'st': 1.6, 'db': 1.0}}})]},
    {'key': 'rare', 'text': 'Okay — now something that’s actually hard to find.', 'breath': 0.24,
     'say': [('Okay, now something that’s actually hard to find.', 0.95,
              {'shift': 1.0, 'range': 1.45, 'end': ('lift', 0.6),
               'accents': {'now': {'st': 1.4}, 'actually': {'st': 2.2, 'stretch': 1.08, 'db': 1.2},
                           'hard': {'st': 2.8, 'stretch': 1.14, 'db': 1.5}}})]},
    {'key': 'there', 'text': 'Oh, there it is.',
     'say': [('Oh, there it is.', 0.94,
              {'shift': 0.2, 'range': 1.18, 'end': ('fall', 1.0),
               'accents': {'there': {'st': 1.4, 'stretch': 1.1, 'db': 1.2}}})]},
    {'key': 'exact', 'text': 'Right down to the exact color, and even the fabric.',
     'say': [('Right down to the exact color, and even the fabric.', 0.98,
              {'shift': 0.8, 'range': 1.3, 'end': ('lift', 0.8),
               'accents': {'exact': {'st': 2.2, 'stretch': 1.08, 'db': 1.2}, 'even': {'st': 1.6, 'db': 1.0},
                           'fabric': {'st': 1.6, 'stretch': 1.06, 'db': 1.0}}})]},
    {'key': 'finale', 'text': 'Describe what you want. Fynd finds it.', 'breath': 0.26,
     'say': [('Describe what you want.', 0.95,
              {'shift': 0.2, 'range': 1.22, 'end': ('level', 0.7),
               'accents': {'Describe': {'st': 1.2}, 'want': {'st': 1.4, 'db': 0.8}}, 'caption': 'Describe what you want.'}),
             0.55,
             ('Find finds it.', 0.9,
              {'shift': -0.2, 'range': 1.25, 'end': ('fall', 1.4),
               'accents': {'finds': {'st': 2.0, 'stretch': 1.08, 'db': 1.2}}, 'caption': 'Fynd finds it.'})]},
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
    only = next((a.split('=', 1)[1].split(',') for a in sys.argv[1:] if a.startswith('--only=')), None)
    known = {line['key'] for line in LINES}
    if only and set(only) - known:
        sys.exit(f'No such line: {", ".join(sorted(set(only) - known))}')
    manifest_path = os.path.join(OUT, 'manifest.json')
    manifest = {'voice': f'Kokoro v1.0 {VOICE}', 'lines': {}}
    if only and os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    shaped_any = any(len(p) > 2 for line in LINES if not only or line['key'] in only
                     for p in line['say'] if not isinstance(p, float))
    asr_dir = os.environ.get('ASR_DIR')
    if shaped_any and (not asr_dir or not os.path.exists(os.path.join(asr_dir, 'tokens.txt'))):
        sys.exit('Set ASR_DIR to an unpacked sherpa-onnx-zipformer-small-en-2023-06-26 directory (word timings).')
    if shaped_any:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import demo_voice

    def record(line, delivered):
        """one take of a line: (clip, rate, timing of its parts, onset)"""
        rate = 24000
        pieces = []
        for part in line['say']:
            if isinstance(part, float):
                pieces.append(('pause', part, None))
                continue
            words, speed = part[0], part[1]
            audio = tts.generate(words, sid=SPEAKER_ID, speed=speed)
            rate = audio.sample_rate
            x = np.asarray(audio.samples, dtype=np.float32)
            if not delivered:
                pieces.append(('speech', x, None))
                continue
            # the delivery: the model's own silence trimmed first, so word
            # times are measured on what is kept
            x = trim(x, rate, keep_start=False, keep_end=False).astype(np.float64)
            spec = part[2]
            script = words.split()
            heard, starts, ends, found = demo_voice.word_times(x, rate, script, asr_dir)
            y, knots = demo_voice.shape(x, rate, script, starts, ends, spec)
            pieces.append(('speech', y.astype(np.float32), {
                'caption': spec.get('caption'), 'words': list(zip(script, demo_voice.carry(starts, knots)))}))
        joined = []
        timing = []
        at = 0.0
        for i, (kind, value, meta) in enumerate(pieces):
            if kind == 'pause':
                chunk = np.zeros(int(rate * value), dtype=np.float32)
            elif delivered:
                chunk = value
            else:
                # each sentence trimmed of the model's own silence, so the
                # pause between two is exactly the one written above
                chunk = trim(value, rate, keep_start=i == 0, keep_end=i == len(pieces) - 1)
            if meta:
                timing.append({'at': at, 'end': at + len(chunk) / rate, **meta})
            joined.append(chunk)
            at += len(chunk) / rate
        clip = np.concatenate(joined)
        onset = 0.0
        if delivered:
            # a little silence each side, so nothing starts or ends on a cut
            pad = np.zeros(int(rate * 0.04), dtype=np.float32)
            onset = len(pad) / rate
            if line.get('breath'):
                level = np.convolve(np.abs(clip), np.ones(480) / 480, 'same')
                ref = float(np.sqrt(np.mean(clip[level > 0.03] ** 2)))
                b = demo_voice.breath(rate, line['breath'], -28, ref, sum(map(ord, line['key']))).astype(np.float32)
                gap = np.zeros(int(rate * 0.06), dtype=np.float32)
                clip = np.concatenate([pad, b, gap, clip, pad])
                onset += (len(b) + len(gap)) / rate
            else:
                clip = np.concatenate([pad, clip, pad])
        return clip, rate, timing, onset

    for line in LINES:
        key = line['key']
        if only and key not in only:
            continue
        speech = [p for p in line['say'] if not isinstance(p, float)]
        delivered = all(len(p) > 2 for p in speech)
        if not delivered:
            clip, rate, timing, onset = record(line, False)
        else:
            # The voice never says a line exactly the same way twice, so
            # it is recorded like a session: several takes, each given its
            # delivery and heard back; of the takes in which every word
            # is still clear, the one whose melody moves most.
            said = demo_voice.normal_words(' '.join(p[0] for p in speech))
            best = None
            for n in range(TAKES):
                take = record(line, True)
                heard, _ = demo_voice._recognise(take[0].astype(np.float64), take[1], asr_dir)
                missed = sum(a != b for a, b in zip(demo_voice.normal_words(heard), said)) + abs(len(demo_voice.normal_words(heard)) - len(said))
                score = (-missed, demo_voice.liveliness(take[0], take[1]))
                if best is None or score > best[0]:
                    best = (score, take, heard)
            (missed, lively), (clip, rate, timing, onset), heard = best[0], best[1], best[2]
            print(f'    {key}: take with {-missed} word(s) unclear, melody {lively:.2f} st')
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as raw:
            sf.write(raw.name, clip, rate, subtype='PCM_24')
        target = os.path.join(OUT, f'{key}.wav')
        finish(raw.name, target, trim_ends=not delivered)
        os.unlink(raw.name)
        entry = {
            'text': line['text'],
            'spoken': ' '.join(p[0] for p in speech),
            'pace': [p[1] for p in speech],
            'file': f'{key}.wav',
            'duration': round(duration(target), 3)
        }
        if delivered:
            entry['onset'] = round(onset, 3)
            entry['delivery'] = [{k: v for k, v in p[2].items() if k != 'caption'} for p in speech]
            # each part's caption: its own, or the line's sentence in the
            # same place
            sentences = re.findall(r'[^.?!…]+[.?!…]+', line['text']) or [line['text']]
            if len(sentences) != len(timing):
                sentences = [line['text']] * len(timing)
            entry['parts'] = [{'text': t['caption'] or sentences[i].strip(), 'at': round(t['at'] + onset, 3), 'end': round(t['end'] + onset, 3)}
                              for i, t in enumerate(timing)]
            entry['words'] = [{'word': w, 'at': round(s + t['at'] + onset, 3)} for t in timing for w, s in t['words']]
            if line.get('breath'):
                entry['breath'] = line['breath']
            # the finished line, heard back: every word has to still be
            # there after its delivery was shaped
            x48, rate48 = sf.read(target)
            heard, _ = demo_voice._recognise(np.asarray(x48, dtype=np.float64), rate48, asr_dir)
            entry['heard'] = heard.lower()
            said = demo_voice.normal_words(entry['spoken'])
            if demo_voice.normal_words(heard) != said:
                print(f'    {key}: heard back as "{heard.lower()}"')
        manifest['lines'][key] = entry
        print(f'  {key:10s} {entry["duration"]:.2f}s  {line["text"]}')

    with open(manifest_path, 'w') as f:
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


def finish(source, target, trim_ends=True):
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
        *([trim_silence] if trim_ends else []),
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

# takes recorded of each of the film's lines, to choose from
TAKES = 6


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
