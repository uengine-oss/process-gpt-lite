"""TIFF fixtures for the TIFF / fax viewer (spec openspec/specs/chat-media-preview, server/test/tiff.test.js, e2e tests F-MP-09 · F-MA-09).

Made once with Pillow 11.3 (libtiff 4.7) on macOS and kept as they are; run again only to change them:

    python3 server/fixtures/tiff/make.py

    fax-2p-g4.tif   a two-page fax as fax machines send it: 1728 × 1100 pixels at 204 × 98 dpi (standard resolution, so each page is
                    shown twice as tall as it is stored), black and white, CCITT Group 4. Page 1 says 「팩스 1쪽」, page 2 「2쪽」.
    fax-g3.tif      page 1 of the fax again as CCITT Group 3 (2-D, EOLs byte-aligned), made from fax-2p-g4.tif with libtiff's tiffcp 4.7:
                        tiffcp -c g3:2d,fill server/fixtures/tiff/fax-2p-g4.tif,0 server/fixtures/tiff/fax-g3.tif
    color-lzw.tif   a 320 × 200 colour picture (three bands of colour and a white square), RGB, LZW.
    gray-deflate.tif a 200 × 120 greyscale picture with 「영수증」 on it, Adobe Deflate (the decoder's inflate: pako).
    broken.tif      a TIFF header whose first directory lies far outside the 16-byte file.
    giant.tif       a valid one-page header that claims 50000 × 50000 pixels (no pixel data): refused before anything is decoded.

The text is drawn with Apple SD Gothic Neo when it is there (any font that has Hangul will do). Nothing here comes from a real fax.
"""
import os
import struct
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def fax_page(n):
    # drawn at the fax's own pixel grid: 1728 wide, 1100 tall (98 dpi down), so the letters are drawn half as tall as wide
    w, h = 1728, 1100
    img = Image.new("L", (w * 1, h * 2), 255)  # drawn square-pixelled first, then squeezed to 98 dpi like a fax machine does
    d = ImageDraw.Draw(img)
    d.rectangle([60, 60, w - 60, 2 * h - 60], outline=0, width=6)
    d.text((140, 180), "FAX  팩스 메시지", font=font(110), fill=0)
    d.text((140, 420), f"{n}쪽 / PAGE {n}", font=font(220), fill=0)
    for k in range(8):
        y = 900 + k * 120
        d.line([140, y, w - 140, y], fill=0, width=5)
        d.text((150, y - 92), f"{k + 1}. 지어낸 시험용 팩스 내용 줄 — line {k + 1}", font=font(64), fill=0)
    if n == 2:
        d.ellipse([w - 520, 2 * h - 520, w - 160, 2 * h - 160], outline=0, width=12)
        d.text((w - 450, 2 * h - 400), "확인", font=font(120), fill=0)
    img = img.resize((w, h), Image.LANCZOS)
    return img.point(lambda v: 255 if v > 150 else 0).convert("1")


def fax():
    p1, p2 = fax_page(1), fax_page(2)
    out = os.path.join(HERE, "fax-2p-g4.tif")
    p1.save(out, compression="group4", dpi=(204, 98), save_all=True, append_images=[p2])
    return out


def color():
    img = Image.new("RGB", (320, 200), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for x in range(320):
        d.line([x, 0, x, 66], fill=(200, 40 + x // 3, 40))
        d.line([x, 67, x, 133], fill=(40, 160, 40 + x // 2))
        d.line([x, 134, x, 199], fill=(40 + x // 2, 60, 200))
    d.rectangle([130, 70, 190, 130], fill=(255, 255, 255))
    out = os.path.join(HERE, "color-lzw.tif")
    img.save(out, compression="tiff_lzw", dpi=(96, 96))
    return out


def gray_deflate():
    img = Image.new("L", (200, 120), 235)
    d = ImageDraw.Draw(img)
    d.rectangle([8, 8, 191, 111], outline=40, width=3)
    d.text((30, 30), "영수증", font=font(44), fill=20)
    out = os.path.join(HERE, "gray-deflate.tif")
    img.save(out, compression="tiff_adobe_deflate", dpi=(150, 150))
    return out


def broken():
    out = os.path.join(HERE, "broken.tif")
    with open(out, "wb") as f:
        f.write(b"II*\x00" + struct.pack("<I", 0x7FFF0000) + b"\x00" * 8)
    return out


def giant():
    # II*\0, the directory at 8: width, height, 1 bit, G4, white is zero, one strip at 0 of 0 bytes
    entries = [(256, 4, 1, 50000), (257, 4, 1, 50000), (258, 3, 1, 1), (259, 3, 1, 4), (262, 3, 1, 0), (273, 4, 1, 0), (278, 4, 1, 50000), (279, 4, 1, 0)]
    body = struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHII", t, ty, n, v) for t, ty, n, v in entries) + struct.pack("<I", 0)
    out = os.path.join(HERE, "giant.tif")
    with open(out, "wb") as f:
        f.write(b"II*\x00" + struct.pack("<I", 8) + body)
    return out


if __name__ == "__main__":
    for made in (fax(), color(), gray_deflate(), broken(), giant()):
        print(made, os.path.getsize(made))
