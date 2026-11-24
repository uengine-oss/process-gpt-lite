#!/usr/bin/env python3
"""build/icon.png (1024×1024) for electron-builder, from the web app's own icon (public/favicon.svg: a dark rounded
square with the paper plane). Drawn on the macOS app icon grid — an 824px body with a soft shadow — so it sits in the
Dock at the size of the other apps (the web app's icon-512.png is full bleed). electron-builder makes .icns/.ico from it.
  python3 scripts/make-icon.py
"""
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SVG = HERE.parent.parent / 'public' / 'favicon.svg'
OUT = HERE.parent / 'build' / 'icon.png'

svg = SVG.read_text()
view = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
rect = re.search(r'<rect[^>]*rx="([\d.]+)"[^>]*fill="(#[0-9a-fA-F]{6})"', svg)
radius, body_fill = float(rect.group(1)), rect.group(2)
path = re.search(r'<path d="([^"]+)" fill="(#[0-9a-fA-F]{6})"', svg)
nums = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', path.group(1))]
plane = list(zip(nums[0::2], nums[1::2]))
plane_fill = path.group(2)

S = 4                       # supersampling
SIZE, BODY, OFF = 1024, 824, 100
k = BODY / view[2]
img = Image.new('RGBA', (SIZE * S, SIZE * S), (0, 0, 0, 0))

# shadow (macOS icons: a soft drop shadow under the body)
shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([OFF * S, (OFF + 10) * S, (OFF + BODY) * S, (OFF + BODY + 10) * S], radius=radius * k * S, fill=(0, 0, 0, 90))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14 * S)))

d = ImageDraw.Draw(img)
d.rounded_rectangle([OFF * S, OFF * S, (OFF + BODY) * S, (OFF + BODY) * S], radius=radius * k * S, fill=body_fill)
d.polygon([((OFF + x * k) * S, (OFF + y * k) * S) for x, y in plane], fill=plane_fill)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT)
print('wrote', OUT)
