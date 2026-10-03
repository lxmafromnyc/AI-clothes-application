#!/usr/bin/env python3
"""
Fynd film - the music bed

A quiet, warm instrumental bed, written and synthesized here: no
samples, no licences, and the same file on every run (the only
randomness is seeded).

  90 BPM, 12 bars = exactly 32.0 seconds, F major.
  Fmaj9 | Dm9 | Bbmaj9 | C6/9   x3, the last bar resolving on Fmaj9.

  - a soft pad (detuned sines, slow attack, low-passed) holds the chords
  - an electric piano (two-operator FM, like a Rhodes) plays a light,
    unhurried pattern - the only thing that makes it rhythmic
  - a round sub bass on the downbeats, low in the mix
  - a brushed shaker on the off-beats from bar 2 to bar 11, very quiet
  - a long, soft room reverb

No drums, no vocals, no lead melody. Bar 1 (the hook) is pad and piano
only; the last bar is the chord alone, fading out by 32.0s.

The file is brought to -27 LUFS integrated with a true peak under -3 dB;
the film plays it at full level between lines and ducks it about 6 dB
under the voice (src/data/timeline.ts musicVolume).

    python3 scripts/music.py    ->  public/audio/music/bed.wav (48 kHz stereo)
Needs numpy and ffmpeg.
"""

import os
import re
import subprocess
import tempfile
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'audio', 'music', 'bed.wav')
RATE = 48000
BPM = 90
BEAT = 60 / BPM
BAR = 4 * BEAT
LENGTH = 32.0
TARGET = -27.0          # LUFS integrated

rng = np.random.default_rng(20261003)
N = int(LENGTH * RATE)
t_all = np.arange(N) / RATE


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# bass note, then the voicing above it
CHORDS = {
    'F': (41, [57, 60, 64, 67]),     # Fmaj9: A C E G over F
    'Dm': (38, [53, 57, 60, 64]),    # Dm9:   F A C E over D
    'Bb': (46, [57, 60, 62, 65]),    # Bbmaj9 (no root): A C D F over Bb
    'C': (36, [55, 57, 62, 64]),     # C6/9:  G A D E over C
}
BARS = ['F', 'Dm', 'Bb', 'C'] * 2 + ['F', 'Dm', 'Bb', 'F']


def lowpass_fast(x, cutoff):
    """A gentle 12 dB/octave low-pass, applied to the whole signal at once."""
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    h = 1 / (1 + (f / cutoff) ** 2)
    return np.fft.irfft(np.fft.rfft(x) * h, len(x))


def highpass_fast(x, cutoff):
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    h = (f / cutoff) ** 2 / (1 + (f / cutoff) ** 2)
    return np.fft.irfft(np.fft.rfft(x) * h, len(x))


def place(buf, start, sig):
    i = int(start * RATE)
    if i >= len(buf):
        return
    n = min(len(sig), len(buf) - i)
    buf[i:i + n] += sig[:n]


def pad_note(freq, dur, amp):
    """Three slightly detuned sines with a touch of second harmonic; a slow
    swell in and a long release."""
    rel = 1.6
    n = int((dur + rel) * RATE)
    t = np.arange(n) / RATE
    sig = np.zeros(n)
    for cents, ph in ((-5, 0.0), (0, 1.3), (6, 2.1)):
        f = freq * 2 ** (cents / 1200)
        sig += np.sin(2 * np.pi * f * t + ph) + 0.12 * np.sin(4 * np.pi * f * t + ph)
    env = np.minimum(1, t / 0.9) ** 2
    env *= np.where(t < dur, 1.0, np.exp(-(t - dur) / (rel / 3)))
    # a slow breathing movement, so a held chord is never static
    env *= 0.9 + 0.1 * np.sin(2 * np.pi * 0.23 * t + freq)
    return amp * sig / 3 * env


def epiano(freq, vel):
    """Two-operator FM: a bell-like attack that mellows quickly, like a
    soft Rhodes played gently."""
    dur = 2.4
    n = int(dur * RATE)
    t = np.arange(n) / RATE
    index = 2.1 * np.exp(-t / 0.22) + 0.4
    mod = np.sin(2 * np.pi * freq * t)
    car = np.sin(2 * np.pi * freq * t + index * mod)
    tine = 0.06 * np.sin(2 * np.pi * freq * 7.0 * t) * np.exp(-t / 0.05)
    env = np.minimum(1, t / 0.004) * np.exp(-t / 0.9)
    trem = 1 + 0.05 * np.sin(2 * np.pi * 4.2 * t)
    return vel * (car + tine) * env * trem


def bass(freq, dur, vel):
    n = int((dur + 0.4) * RATE)
    t = np.arange(n) / RATE
    sig = np.sin(2 * np.pi * freq * t) + 0.18 * np.sin(4 * np.pi * freq * t)
    env = np.minimum(1, t / 0.02) * np.exp(-t / 0.75)
    env *= np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.08))
    return vel * sig * env


def shaker(vel):
    n = int(0.09 * RATE)
    t = np.arange(n) / RATE
    noise = rng.standard_normal(n)
    env = np.minimum(1, t / 0.006) * np.exp(-t / 0.028)
    return vel * noise * env


def reverb_ir(seconds, seed):
    r = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    ir = r.standard_normal(n) * np.exp(-t / (seconds / 6.5))
    ir[: int(0.012 * RATE)] = 0          # a short pre-delay
    ir = lowpass_fast(ir, 3500)
    return ir / np.sqrt(np.sum(ir ** 2))


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << int(np.ceil(np.log2(n)))
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]


def build():
    pad = np.zeros(N)
    keys_l = np.zeros(N)
    keys_r = np.zeros(N)
    low = np.zeros(N)
    shake = np.zeros(N)

    # the piano's pattern, in beats within the bar: (beat, which chord
    # tones, velocity). Unhurried: a few notes, room between them.
    PATTERN = [(0.0, [0, 2], 0.62), (1.5, [3], 0.42), (2.5, [1, 2], 0.5), (3.5, [3], 0.34)]

    for b, name in enumerate(BARS):
        start = b * BAR
        root, voicing = CHORDS[name]
        last = b == len(BARS) - 1
        # pad: the whole chord, plus the root an octave up for warmth
        for m in voicing + [root + 12]:
            place(pad, start, pad_note(hz(m), BAR + 0.15, 0.05 if m != root + 12 else 0.022))
        # piano
        pattern = [(0.0, [0, 1, 2, 3], 0.5)] if last else PATTERN
        for beat, tones, vel in pattern:
            jitter = rng.uniform(-0.012, 0.012)
            human = vel * rng.uniform(0.88, 1.06)
            for k, tone in enumerate(tones):
                # a chord is rolled a little, as a hand plays it
                # the piano sits an octave above the pad, clear of it
                note = epiano(hz(voicing[tone] + 12), human * (0.9 if k else 1.0))
                when = start + beat * BEAT + jitter + k * 0.018
                pan = 0.5 + (tone - 1.5) * 0.12
                place(keys_l, when, note * np.sqrt(1 - pan))
                place(keys_r, when, note * np.sqrt(pan))
        # bass: the root on the downbeat and a softer push on the "and" of 3
        place(low, start, bass(hz(root - 12 if root > 44 else root), 1.9 if not last else 2.6, 0.36))
        if not last:
            place(low, start + 2.5 * BEAT, bass(hz((root - 12 if root > 44 else root) + 7), 0.9, 0.18))
        # shaker on the off-beats, bars 2-11, with a little swing
        if 1 <= b <= 10:
            for i in range(8):
                swing = 0.045 if i % 2 else 0.0
                vel = (0.5 if i % 2 else 0.28) * rng.uniform(0.75, 1.0)
                place(shake, start + i * BEAT / 2 + swing, shaker(vel))

    pad = lowpass_fast(pad, 2400)
    low = lowpass_fast(low, 260)
    shake = lowpass_fast(highpass_fast(shake, 5500), 11000)
    keys_l = lowpass_fast(keys_l, 6000)
    keys_r = lowpass_fast(keys_r, 6000)

    # the mix, dry
    left = 0.85 * pad + 1.3 * keys_l + 0.9 * low + 0.16 * shake
    right = 0.85 * pad + 1.3 * keys_r + 0.9 * low + 0.16 * shake
    # a shaker a touch to the right, the pad a touch wide
    right += 0.03 * shake
    left += 0.05 * np.roll(pad, int(0.011 * RATE))

    # room
    wet_l = convolve(0.7 * pad + 1.7 * keys_l + 0.08 * shake, reverb_ir(2.4, 1))
    wet_r = convolve(0.7 * pad + 1.7 * keys_r + 0.08 * shake, reverb_ir(2.4, 2))
    left = left + 0.28 * wet_l
    right = right + 0.28 * wet_r

    # a gentle start and a natural end
    fade_in = np.minimum(1, t_all / 1.2) ** 2
    fade_out = np.clip((LENGTH - t_all) / 2.2, 0, 1) ** 1.5
    left *= fade_in * fade_out
    right *= fade_in * fade_out
    # nothing below 35 Hz
    left = highpass_fast(left, 35)
    right = highpass_fast(right, 35)
    return np.stack([left, right], axis=1)


def write(path, stereo):
    pcm = np.clip(stereo, -1, 1)
    data = (pcm * 32767).astype('<i2').tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)


def loudness(path):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    i = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])
    peak = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', out)[-1])
    return i, peak


def main():
    mix = build()
    mix /= np.max(np.abs(mix)) / 0.5
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        write(tmp.name, mix)
        lufs, _ = loudness(tmp.name)
    os.unlink(tmp.name)
    mix *= 10 ** ((TARGET - lufs) / 20)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    write(OUT, mix)
    lufs, peak = loudness(OUT)
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {LENGTH:.1f}s, {lufs:.1f} LUFS integrated, true peak {peak:.1f} dBFS')
    if abs(lufs - TARGET) > 0.5 or peak > -3:
        raise SystemExit('the bed is off its level target')


if __name__ == '__main__':
    main()
