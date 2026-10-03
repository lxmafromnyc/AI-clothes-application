#!/usr/bin/env python3
"""
Checks a rendered film against what it was meant to be:

  - 32.0 seconds, 30 fps, the right size, an audio track
  - every voice line found in the film's sound where its caption says it
    starts (cross-correlation of each line's own clip against the mixed
    track: within one frame)
  - captions inside the film, never overlapping
  - the voice at about -18 LUFS, the music alone at about -29, and every
    line at least 8 LU over the music

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
    vtt = sys.argv[2] if len(sys.argv) > 2 else re.sub(r'\.(mp4|webm|wav)$', '.vtt', film)
    problems = []

    info = probe(film)
    v = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
    dur = float(info['format']['duration'])
    if v:
        num, den = map(int, v['r_frame_rate'].split('/'))
        print(f'{os.path.basename(film)}: {v["width"]}x{v["height"]}, {num / den:g} fps, {dur:.2f}s, audio {"yes" if has_audio else "NO"}')
        if num / den != FPS:
            problems.append(f'{num / den} fps, not {FPS}')
    else:
        print(f'{os.path.basename(film)}: soundtrack only, {dur:.2f}s')
    if abs(dur - 32.0) > 0.08:
        problems.append(f'{dur:.2f}s long, not 32.0s')
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

    print(f'  whole mix   {lufs(film):.1f} LUFS integrated')

    # the music must never compete with the speech: each line, heard in the
    # mix, against the music alone (a stretch between the last line and the
    # closing fade, where nothing else plays)
    beats = [(start, start + line['durationInFrames'] / FPS) for line, (start, _, _) in zip(voice, cs)]
    # the music alone: the longest stretch with no line being said (clear of
    # the ducking either side), before the closing fade
    gaps = [(beats[i][1] + 0.6, beats[i + 1][0] - 0.4) for i in range(len(beats) - 1)]
    a, b = max(gaps, key=lambda g: g[1] - g[0])
    music_alone = lufs(film, a, b - a)
    print(f'  music alone {music_alone:.1f} LUFS ({a:.1f}-{b:.1f}s, nobody speaking)')
    if not -31 <= music_alone <= -26:
        problems.append(f'the music alone is {music_alone:.1f} LUFS, outside -31..-26')
    for line, (a, b) in zip(voice, beats):
        speech = lufs(film, a, b - a)
        margin = speech - music_alone
        print(f'  {line["id"]:12s} {speech:6.1f} LUFS in the mix, {margin:4.1f} LU over the music')
        if not -21 <= speech <= -15:
            problems.append(f'"{line["id"]}" is {speech:.1f} LUFS in the mix, not about -18')
        if margin < 8:
            problems.append(f'the music is within {margin:.1f} LU of "{line["id"]}"')
    return finish(problems)


def lufs(path, start=None, length=None):
    cut = ['-ss', f'{start:.3f}', '-t', f'{length:.3f}'] if start is not None else []
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', *cut, '-i', path, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])


def finish(problems):
    if problems:
        print('✗ ' + '\n✗ '.join(problems))
        sys.exit(1)
    print('✓ in sync')


if __name__ == '__main__':
    main()
