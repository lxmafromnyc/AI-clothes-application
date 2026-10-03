#!/usr/bin/env python3
"""
Checks a rendered film against what it was meant to be:

  - 32.0 seconds, 30 fps, the right size, an audio track
  - every voice line found in the film's sound where its caption says it
    starts (cross-correlation of each line's own clip against the mixed
    track: within one frame)
  - captions inside the film, never overlapping
  - overall loudness

    python3 scripts/verify.py out/fynd-demo.mp4 [out/fynd-demo.vtt]

Needs ffmpeg/ffprobe and numpy.
"""

import json
import os
import re
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RATE = 16000
FPS = 30


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
                          '-of', 'json', path], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def audio(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def cues(vtt):
    text = open(vtt, encoding='utf8').read()
    t = lambda h, m, s, ms: int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
    return [(t(*m[0:4]), t(*m[4:8]), m[8]) for m in re.findall(r'(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\n(.+)', text)]


def find(track, clip, expect):
    """Where the clip best matches the track, searched around where it is
    expected (±1.5s), in seconds."""
    lo = max(0, int((expect - 1.5) * RATE))
    hi = min(len(track), int((expect + 1.5) * RATE) + len(clip))
    seg = track[lo:hi]
    n = 1 << int(np.ceil(np.log2(len(seg) + len(clip))))
    corr = np.fft.irfft(np.fft.rfft(seg, n) * np.conj(np.fft.rfft(clip, n)), n)[:len(seg) - len(clip) + 1]
    return (lo + int(np.argmax(corr))) / RATE


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    film = sys.argv[1]
    vtt = sys.argv[2] if len(sys.argv) > 2 else re.sub(r'\.(mp4|webm)$', '.vtt', film)
    problems = []

    info = probe(film)
    v = next(s for s in info['streams'] if s['codec_type'] == 'video')
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
    dur = float(info['format']['duration'])
    num, den = map(int, v['r_frame_rate'].split('/'))
    print(f'{os.path.basename(film)}: {v["width"]}x{v["height"]}, {num / den:g} fps, {dur:.2f}s, audio {"yes" if has_audio else "NO"}')
    if abs(dur - 32.0) > 0.08:
        problems.append(f'{dur:.2f}s long, not 32.0s')
    if num / den != FPS:
        problems.append(f'{num / den} fps, not {FPS}')
    if not has_audio:
        problems.append('no audio track')
        return finish(problems)

    track = audio(film)
    voice = json.load(open(os.path.join(ROOT, 'public', 'audio', 'narration', 'voice.json')))
    cs = cues(vtt)
    if len(cs) != len(voice):
        problems.append(f'{len(cs)} captions for {len(voice)} lines')
    for i, (start, end, text) in enumerate(cs):
        if end > dur + 0.01:
            problems.append(f'caption {i + 1} runs past the end')
        if i + 1 < len(cs) and end > cs[i + 1][0]:
            problems.append(f'captions {i + 1} and {i + 2} overlap')
    for line, (start, end, text) in zip(voice, cs):
        clip = audio(os.path.join(ROOT, 'public', line['file']))
        heard = find(track, clip, start)
        off = (heard - start) * 1000
        ok = abs(off) <= 1000 / FPS
        print(f'  {line["id"]:12s} caption {start:6.3f}s  heard {heard:6.3f}s  ({off:+.0f} ms)  {"ok" if ok else "OUT OF SYNC"}')
        if not ok:
            problems.append(f'"{line["id"]}" is heard {off:+.0f} ms from its caption')
        if text != line['caption']:
            problems.append(f'caption {text!r} is not the line {line["caption"]!r}')

    loud = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', film, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
                          capture_output=True, text=True).stderr
    m = re.findall(r'I:\s+(-?[\d.]+) LUFS', loud)
    if m:
        print(f'  loudness {m[-1]} LUFS integrated')
    return finish(problems)


def finish(problems):
    if problems:
        print('✗ ' + '\n✗ '.join(problems))
        sys.exit(1)
    print('✓ in sync')


if __name__ == '__main__':
    main()
