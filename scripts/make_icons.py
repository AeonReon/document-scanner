#!/usr/bin/env python3
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "images"
OUT.mkdir(exist_ok=True)

BG_TOP = (255, 244, 230)
BG_BOT = (255, 220, 235)
ACCENT_A = (255, 122, 89)
ACCENT_B = (255, 173, 96)
DOC = (255, 255, 255)
INK = (60, 50, 70)
SCAN = (90, 200, 170)

def draw_doc_icon(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(size * (0.12 if maskable else 0.04))
    r = int(size * 0.22)
    for y in range(size):
        t = y / size
        col = (
            int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t),
            int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t),
            int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t),
            255,
        )
        d.line([(pad, y), (size - pad, y)], fill=col)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bgd = ImageDraw.Draw(bg)
    bgd.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=(255, 255, 255, 255))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    based = ImageDraw.Draw(base)
    for y in range(pad, size - pad):
        t = (y - pad) / max(1, size - 2 * pad)
        col = (
            int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t),
            int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t),
            int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t),
            255,
        )
        based.line([(pad, y), (size - pad, y)], fill=col)
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=255)
    out.paste(base, (0, 0), mask)
    dd = ImageDraw.Draw(out)
    dw = int(size * 0.46)
    dh = int(size * 0.60)
    dx = (size - dw) // 2
    dy = int(size * 0.18)
    fold = int(size * 0.10)
    poly = [
        (dx, dy),
        (dx + dw - fold, dy),
        (dx + dw, dy + fold),
        (dx + dw, dy + dh),
        (dx, dy + dh),
    ]
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sdr = ImageDraw.Draw(shadow)
    off = max(2, int(size * 0.01))
    sp = [(x + off, y + off) for (x, y) in poly]
    sdr.polygon(sp, fill=(0, 0, 0, 60))
    out.alpha_composite(shadow)
    dd.polygon(poly, fill=DOC)
    dd.polygon([
        (dx + dw - fold, dy),
        (dx + dw - fold, dy + fold),
        (dx + dw, dy + fold),
    ], fill=(240, 235, 230))
    line_l = dx + int(size * 0.05)
    line_r = dx + dw - int(size * 0.05)
    base_y = dy + int(size * 0.20)
    step = int(size * 0.07)
    for i in range(4):
        end = line_r if i != 3 else dx + int((line_r - dx) * 0.55)
        dd.line([(line_l, base_y + i * step), (end, base_y + i * step)], fill=INK, width=max(2, int(size * 0.012)))
    scan_y = dy + int(dh * 0.78)
    sw = int(dw * 0.85)
    sx = dx + (dw - sw) // 2
    dd.rounded_rectangle([sx, scan_y, sx + sw, scan_y + max(3, int(size * 0.018))], radius=4, fill=SCAN)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdr = ImageDraw.Draw(glow)
    for i in range(6):
        a = 60 - i * 9
        gdr.line([(sx - i, scan_y + i + 6), (sx + sw + i, scan_y + i + 6)], fill=(*SCAN, max(0, a)))
    out.alpha_composite(glow)
    return out

for size in (192, 512):
    img = draw_doc_icon(size)
    img.save(OUT / f"icon-{size}.png")
img = draw_doc_icon(512, maskable=True)
img.save(OUT / "icon-maskable.png")
img = draw_doc_icon(180)
img.save(OUT / "apple-touch-icon.png")
img = draw_doc_icon(32)
img.save(OUT / "favicon-32.png")
print("Icons written to", OUT)
