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

Fynd's 16 px toolbar icon is a near-black filled square with a white "F";
other toolbar icons are thin outlines, so the first 12 px block that is mostly
near-black in the toolbar band, right of the address bar, is Fynd's.
"""
import subprocess
import sys
import time
from io import BytesIO

from PIL import Image
from Xlib import X, display
from Xlib.ext import xtest


def shot(disp):
    png = subprocess.run(['import', '-display', disp, '-window', 'root', 'png:-'], check=True, capture_output=True).stdout
    return Image.open(BytesIO(png)).convert('RGB')


def find(disp):
    im = shot(disp)
    w, h = im.size
    px = im.load()
    dark = lambda x, y: sum(px[x, y]) < 120
    block = 12
    for y in range(40, min(90, h - block)):
        for x in range(int(w * 0.55), w - block):
            if not dark(x, y):
                continue
            hits = sum(1 for dx in range(block) for dy in range(block) if dark(x + dx, y + dy))
            if hits >= block * block * 0.6:
                return x + block // 2, y + block // 2
    return None


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


def main(argv):
    disp, cmd = argv[1], argv[2]
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
