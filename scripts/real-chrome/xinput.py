#!/usr/bin/env python3
"""Real mouse input for Fynd's real-Chrome test (scripts/test-fit-panel-real-chrome.js).

Chrome grants an extension access to a tab (activeTab) only when the person
clicks its toolbar button: no DevTools command can stand in for that. This
helper sends a genuine X11 click (the XTEST extension) to Chromium running on
an Xvfb display, after finding Fynd's button on a screenshot of the toolbar.

  xinput.py DISPLAY shot PATH            screenshot of the whole display
  xinput.py DISPLAY find                 print "x y" of Fynd's toolbar button
  xinput.py DISPLAY click-fynd           find it and click it; print "x y"
  xinput.py DISPLAY click X Y            click at a point
  xinput.py DISPLAY ready                wait (up to 15 s) until the display accepts connections
  xinput.py DISPLAY describe             the screen's size and its most common colours

Finding the button: Fynd's own icon (extension/icons, a dark square with a
white "F") is matched against the toolbar band of the screenshot, at the
sizes Chrome draws toolbar icons; failing a close match, the first 12 px
block that is mostly near-black right of the address bar (other toolbar
icons are thin outlines). Prints "none" and exits 2 when neither finds it.
"""
import os
import subprocess
import sys
import time
from io import BytesIO

from PIL import Image
from Xlib import X, display
from Xlib.ext import xtest

ICONS = os.path.join(os.path.dirname(__file__), '..', '..', 'extension', 'icons')


def shot(disp):
    png = subprocess.run(['import', '-display', disp, '-window', 'root', 'png:-'], check=True, capture_output=True).stdout
    return Image.open(BytesIO(png)).convert('RGB')


def dark_mask(im):
    w, h = im.size
    px = im.load()
    return [[sum(px[x, y]) < 160 for x in range(w)] for y in range(h)]


def match(im):
    """the icon's dark/light pattern, slid over the toolbar band"""
    w, h = im.size
    band = im.crop((int(w * 0.5), 30, w, min(h, 110)))
    bw, bh = band.size
    screen = dark_mask(band)
    best = None
    for size in (16, 18, 20, 24, 32):
        icon = Image.open(os.path.join(ICONS, 'icon-32.png')).convert('RGBA').resize((size, size))
        ipx = icon.load()
        cells = [(x, y, sum(ipx[x, y][:3]) < 160) for x in range(size) for y in range(size) if ipx[x, y][3] > 200]
        if not cells:
            continue
        for oy in range(0, bh - size):
            for ox in range(0, bw - size):
                if not screen[oy + size // 2][ox + size // 2] and not screen[oy + 2][ox + 2]:
                    continue
                agree = sum(1 for x, y, d in cells if screen[oy + y][ox + x] == d)
                score = agree / len(cells)
                if best is None or score > best[0]:
                    best = (score, int(w * 0.5) + ox + size // 2, 30 + oy + size // 2)
    return best if best and best[0] >= 0.85 else None


def block(im):
    w, h = im.size
    px = im.load()
    dark = lambda x, y: sum(px[x, y]) < 120
    size = 12
    for y in range(40, min(90, h - size)):
        for x in range(int(w * 0.55), w - size):
            if not dark(x, y):
                continue
            hits = sum(1 for dx in range(size) for dy in range(size) if dark(x + dx, y + dy))
            if hits >= size * size * 0.6:
                return x + size // 2, y + size // 2
    return None


def find(disp):
    im = shot(disp)
    m = match(im)
    if m:
        return m[1], m[2]
    return block(im)


def click(disp, x, y):
    d = display.Display(disp)
    d.screen().root.warp_pointer(x, y)
    d.sync()
    time.sleep(0.15)
    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    time.sleep(0.08)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    d.close()


def ready(disp):
    for _ in range(60):
        try:
            display.Display(disp).close()
            return True
        except Exception:
            time.sleep(0.25)
    return False


def main(argv):
    disp, cmd = argv[1], argv[2]
    if cmd == 'ready':
        ok = ready(disp)
        print('ready' if ok else 'not ready')
        return 0 if ok else 2
    if cmd == 'describe':
        im = shot(disp)
        colours = sorted(im.getcolors(1 << 24) or [], reverse=True)
        print(f'{im.size[0]}x{im.size[1]}, {len(colours)} colours, most common: {colours[:4]}')
        return 0
    if cmd == 'shot':
        shot(disp).save(argv[3])
    elif cmd == 'find':
        at = find(disp)
        print('none' if at is None else f'{at[0]} {at[1]}')
    elif cmd == 'click-fynd':
        at = find(disp)
        if at is None:
            print('none')
            return 2
        click(disp, *at)
        print(f'{at[0]} {at[1]}')
    elif cmd == 'click':
        click(disp, int(argv[3]), int(argv[4]))
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
