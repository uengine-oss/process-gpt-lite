#!/usr/bin/env python3
"""The tray (menu bar) icons, from the app icon build/icon.png (scripts/make-icon.py — a dark rounded square with the paper
plane, an 824px body at 100,100 on the 1024 macOS grid). src/tray.js loads them; electron-builder packs resources/** (files).
  resources/tray/tray.png · tray@2x.png                     Windows · Linux: the app icon itself, 16 and 32 px (the count badge
                                                            is drawn on it at run time — src/badge.js)
  resources/tray/trayTemplate.png · trayTemplate@2x.png     macOS menu bar: a template image (black + alpha — macOS tints it for
                                                            a light or dark bar), the body with the plane cut out, 1px inside
  python3 scripts/make-tray.py        (npm run icon runs it after make-icon.py)
"""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'build' / 'icon.png'
OUT = HERE.parent / 'resources' / 'tray'
OFF, BODY = 100, 824

icon = Image.open(SRC).convert('RGBA')
body = icon.crop((OFF, OFF, OFF + BODY, OFF + BODY))

# the plane: its light pixels (#f5f5f7 on #1d1d1f — the shadow and the body's edge stay out)
lum = body.convert('RGB').convert('L')
plane = lum.point(lambda v: max(0, min(255, round((v - 80) * 255 / 160))))
alpha = body.getchannel('A')
# the template's mask: the body's alpha less the plane
cut = Image.frombytes('L', body.size, bytes(max(0, a - p) for a, p in zip(alpha.tobytes(), plane.tobytes())))


def colour(size):
    return body.resize((size, size), Image.LANCZOS)


def template(size, pad):
    m = cut.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(Image.new('RGBA', m.size, (0, 0, 0, 255)), (pad, pad), m)
    return out


OUT.mkdir(parents=True, exist_ok=True)
for name, img in [('tray.png', colour(16)), ('tray@2x.png', colour(32)),
                  ('trayTemplate.png', template(16, 1)), ('trayTemplate@2x.png', template(32, 2))]:
    img.save(OUT / name, optimize=True)
    print('wrote', OUT / name)
