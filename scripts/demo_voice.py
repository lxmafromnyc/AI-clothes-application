"""
Fynd - shaping the narration's delivery

The narration is spoken by a neural voice (scripts/demo-narration.py).
On its own, every line it says sits in the same register with the same
melody, and ends the same way: correct, and flat. This module gives each
line a delivery, the way a person showing someone something would vary
theirs, by changing only the pitch and timing of the voice's own
recording:

  register   where the line sits: curious, a lift when something
             appears, more interested at the hard example, settled and
             sure at the end
  range      how much the melody moves around that register
  accents    a pitch rise (and the faintest level rise) on the word the
             line is about, and a touch more time on it
  endings    a question rises; a line that leads on lifts; a
             conclusion settles - not every sentence falling the same way
  breaths    a short, soft inhale before a line that starts a new thought

The changes are made with Praat's PSOLA (through parselmouth): the
voice's own waveform, one grain per pitch period, re-spaced at the new
period; Praat's pitch analysis decides what is voiced. For changes of a
few semitones it keeps the voice's own timbre and texture - a vocoder
would resynthesise it, and add a breathiness of its own - and every
word stays as clear as it was: each finished line is checked by running
it back through the recogniser (scripts/demo-narration.py).

Where the words are comes from an offline recogniser's token timestamps
(sherpa-onnx, a small English zipformer): every word of the script is
found in the recording, so an accent lands on its word, and the film can
set its type on the moment a word is said.

Needs: numpy, scipy, praat-parselmouth, sherpa-onnx.
"""

import os
import re

import numpy as np


# ---------------------------------------------------------------
# A line's delivery
# ---------------------------------------------------------------

def _rc(t, a, b):
    """raised cosine from 0 to 1 over [a, b]"""
    return np.where(t <= a, 0.0, np.where(t >= b, 1.0, 0.5 - 0.5 * np.cos(np.pi * (t - a) / max(1e-6, b - a))))


def _bare(word):
    return word.strip('.,!?;:—–-').lower()


def shape(x, fs, words, starts, ends, spec):
    """x spoken with the delivery in spec:

      shift     semitones: the line's register against the voice's own
      range     the melody's movement around it, as a factor
      accents   {word: {'st': semitones, 'db': level, 'stretch': time}}
      end       ('rise' | 'fall' | 'lift' | 'level' | 'question', semitones)
      ceiling   how far above its register a syllable may go before it
                is eased back (semitones, softly)

    Returns the new audio, and the time map (t_out, t_in) it was made
    with, so word times can be carried across."""
    import parselmouth
    from parselmouth.praat import call
    dur = len(x) / fs
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=fs)
    manipulation = call(snd, 'To Manipulation', 0.005, 75, 500)
    tier = call(manipulation, 'Extract pitch tier')
    n = int(call(tier, 'Get number of points'))
    if n < 3:
        return x.copy(), [(0.0, 0.0), (dur, dur)]
    t = np.array([call(tier, 'Get time from index', i) for i in range(1, n + 1)])
    hz = np.array([call(tier, 'Get value at index', i) for i in range(1, n + 1)])
    st = 12 * np.log2(hz / 100)
    mu = float(np.median(st))
    k = spec.get('range', 1.0)
    target = spec.get('shift', 0.0) + (k - 1) * (st - mu)
    gain_t = np.linspace(0, dur, int(dur * 200) + 1)
    gain = np.zeros_like(gain_t)
    stretches = []
    for key, acc in spec.get('accents', {}).items():
        hits = [j for j, w in enumerate(words) if _bare(w) == _bare(key)]
        if not hits:
            raise ValueError(f'no word {key!r} in {words}')
        j = hits[acc.get('nth', 0)]
        ws, we = starts[j], ends[j]
        peak = ws + 0.4 * (we - ws)
        bump = lambda tt: _rc(tt, ws - 0.04, peak) * (1 - _rc(tt, peak + 0.02, we + 0.08))
        target = target + acc.get('st', 1.5) * bump(t)
        gain = gain + acc.get('db', 1.0) * bump(gain_t)
        if acc.get('stretch', 1.0) != 1.0:
            stretches.append((ws, we, acc['stretch']))
    if spec.get('end'):
        kind, amount = spec['end']
        last = t[-1]
        span = spec.get('end_span', 0.42)
        if kind == 'rise':
            target = target + amount * _rc(t, last - span, last)
        elif kind == 'fall':
            target = target - amount * _rc(t, last - span, last)
        elif kind == 'lift':
            target = target + amount * _rc(t, last - span, last - span * 0.4) - 0.4 * amount * _rc(t, last - span * 0.4, last)
        elif kind == 'level':
            target = target - (k - 1) * (st - mu) * _rc(t, last - span, last) * amount
        elif kind == 'question':
            # a real question's rise: over the last span the melody is drawn
            # towards a glide upward from where it stood, whatever the model
            # did there (it tends to rise and then drop on the last word)
            r = _rc(t, last - span, last - span * 0.6)
            s0 = float(np.interp(last - span, t, st + target))
            glide = s0 + amount * np.clip((t - (last - span)) / span, 0, 1)
            target = target + r * (glide - (st + target))
    # a soft ceiling: emphasis is kept, but no syllable is pushed far above
    # the line's own register - a voice that leaps there sounds strained
    ceiling = spec.get('ceiling', 5.5)
    over = st + target - (mu + spec.get('shift', 0.0)) - ceiling
    target = np.where(over > 0, target - over * 0.65, target)
    call(tier, 'Remove points between', 0, dur)
    for tt, f in zip(t, hz * 2 ** (target / 12)):
        call(tier, 'Add point', float(tt), float(f))
    call([manipulation, tier], 'Replace pitch tier')
    knots = [(0.0, 0.0)]
    if stretches:
        durations = call(manipulation, 'Extract duration tier')
        out_t = 0.0
        in_t = 0.0
        for ws, we, f in sorted(stretches):
            for tt, v in ((ws - 0.002, 1.0), (ws, f), (we, f), (we + 0.002, 1.0)):
                call(durations, 'Add point', tt, v)
            out_t += ws - in_t
            knots.append((out_t, ws))
            out_t += (we - ws) * f
            knots.append((out_t, we))
            in_t = we
        knots.append((out_t + dur - in_t, dur))
        call([manipulation, durations], 'Replace duration tier')
    else:
        knots.append((dur, dur))
    y = call(manipulation, 'Get resynthesis (overlap-add)').values[0]
    to = np.array([a for a, _ in knots])
    ti = np.array([b for _, b in knots])
    g = 10 ** (np.interp(np.interp(np.arange(len(y)) / fs, to, ti), gain_t, gain) / 20)
    return y * g, knots


def liveliness(x, fs):
    """how much a take's melody moves: the spread of its pitch, in
    semitones"""
    import parselmouth
    pitch = parselmouth.Sound(np.asarray(x, dtype=np.float64), sampling_frequency=fs).to_pitch(0.01, 75, 500)
    hz = pitch.selected_array['frequency']
    hz = hz[hz > 0]
    return float(np.std(12 * np.log2(hz / 100))) if len(hz) > 5 else 0.0


def carry(times, knots):
    """input-time moments, mapped through a time map to output time"""
    to = np.array([a for a, _ in knots])
    ti = np.array([b for _, b in knots])
    return [float(np.interp(s, ti, to)) for s in times]


def breath(fs, dur, level_db, ref_rms, seed):
    """A short inhale through a relaxed, slightly open mouth: soft
    turbulence through an open-vowel tract, almost all of it below
    2.5 kHz, swelling and falling away; level_db under the line's own
    speech level."""
    import scipy.signal as ss
    rng = np.random.default_rng(seed)
    n = int(dur * fs)
    noise = rng.standard_normal(n + 4096)
    y = np.zeros(n + 4096)
    for f, bw, g in [(520, 380, 1.0), (980, 520, 0.8), (1700, 800, 0.4), (2600, 1100, 0.15)]:
        b, a = ss.iirpeak(f, f / bw, fs=fs)
        y += g * ss.lfilter(b, a, noise)
    b, a = ss.butter(2, [220, 2800], 'bandpass', fs=fs)
    y = ss.lfilter(b, a, y)[4096:]
    tt = np.arange(n) / n
    env = np.sin(np.pi * np.clip(tt / 0.6, 0, 1) / 2) ** 2 * (1 - _rc(tt, 0.6, 1.0)) ** 1.4
    y = y * env
    return y / (np.sqrt(np.mean(y[env > 0.3] ** 2)) + 1e-9) * ref_rms * 10 ** (level_db / 20)


# ---------------------------------------------------------------
# Where the words are
# ---------------------------------------------------------------

_recogniser = None


def _recognise(x, fs, model_dir):
    global _recogniser
    import sherpa_onnx
    from scipy.signal import resample_poly
    if _recogniser is None:
        _recogniser = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(model_dir, 'encoder-epoch-99-avg-1.onnx'),
            decoder=os.path.join(model_dir, 'decoder-epoch-99-avg-1.onnx'),
            joiner=os.path.join(model_dir, 'joiner-epoch-99-avg-1.onnx'),
            tokens=os.path.join(model_dir, 'tokens.txt'), num_threads=4, decoding_method='greedy_search')
    y = resample_poly(x.astype(np.float64), 16000, fs).astype(np.float32)
    stream = _recogniser.create_stream()
    stream.accept_waveform(16000, np.concatenate([np.zeros(1600, np.float32), y, np.zeros(4800, np.float32)]))
    _recogniser.decode_stream(stream)
    words = []
    for tok, at in zip(stream.result.tokens, stream.result.timestamps):
        if tok.startswith(' ') or tok.startswith('▁') or not words:
            words.append([tok.strip().lstrip('▁'), at - 0.1])
        else:
            words[-1][0] += tok
    # spelled-out letters ("O K") back into one word
    merged = []
    for w, at in words:
        if merged and len(w) == 1 and len(merged[-1][0]) == 1 and w.isalpha():
            merged[-1][0] += w
        else:
            merged.append([w, at])
    return stream.result.text, merged


def _norm(word):
    w = re.sub(r"[^a-z']", '', word.lower().replace('’', "'"))
    return {'okay': 'ok', 'fynd': 'find'}.get(w, w)


def normal_words(text):
    """a sentence as the recogniser writes it, to compare the two"""
    out = []
    for w in re.findall(r"[A-Za-z’']+", text):
        n = _norm(w)
        out += ['o', 'k'] if n == 'ok' else [n]
    return out


def word_times(x, fs, words, model_dir):
    """(heard, starts, ends, found): each script word's start in x, the
    next word's start as its end, and how many words were found"""
    heard, rw = _recognise(x, fs, model_dir)
    starts = []
    j = 0
    for word in words:
        n = _norm(word)
        hit = None
        for k in range(j, min(j + 3, len(rw))):
            r = _norm(rw[k][0])
            if r == n or (len(n) > 3 and r.startswith(n[:4])):
                hit = k
                break
        starts.append(None if hit is None else max(0.0, rw[hit][1]))
        if hit is not None:
            j = hit + 1
    found = sum(s is not None for s in starts)
    arr = np.array([np.nan if s is None else s for s in starts], dtype=float)
    i = np.arange(len(arr))
    ok = ~np.isnan(arr)
    arr = np.interp(i, i[ok], arr[ok]) if ok.any() else i * 0.3
    ends = list(arr[1:]) + [len(x) / fs]
    return heard, [float(s) for s in arr], [float(e) for e in ends], found
