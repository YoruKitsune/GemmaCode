"""Рисует иконку GemmaCode (build/icon.png, 1024x1024) и её уменьшенные копии. Запуск: python3 tools/make-icon.py"""
import math, os, sys
from PIL import Image, ImageDraw, ImageFilter

S = 4096  # рисуем в 4x и уменьшаем: гладкие края
out = os.path.join(os.path.dirname(__file__), '..', 'apps', 'desktop', 'build')
os.makedirs(out, exist_ok=True)

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# фон: скруглённый квадрат с диагональным градиентом (тёмно-синий -> фиолетовый)
bg = Image.new('RGB', (S, S))
px = bg.load()
c0, c1 = (22, 28, 52), (74, 52, 140)
for y in range(S):
    for x in range(S):
        px[x, y] = lerp(c0, c1, (x + y) / (2 * S))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

d = ImageDraw.Draw(img)
cx, cy = S / 2, S * 0.5
r = S * 0.30
# огранённый камень (самоцвет): шестиугольник с гранями разной яркости
pts = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
top, tr, br, bot, bl, tl = pts
c = (cx, cy)
facets = [
    ((top, tr, c), (150, 190, 255)),
    ((tr, br, c), (96, 140, 235)),
    ((br, bot, c), (70, 104, 200)),
    ((bot, bl, c), (96, 140, 235)),
    ((bl, tl, c), (126, 168, 250)),
    ((tl, top, c), (176, 212, 255)),
]
for poly, col in facets:
    d.polygon(poly, fill=col)
for a, b in zip(pts, pts[1:] + pts[:1]):
    d.line((a, b), fill=(235, 244, 255), width=int(S * 0.006))
# приглашение терминала «>_» поверх камня
w = int(S * 0.045)
x0, y0 = cx - r * 0.38, cy - r * 0.30
d.line([(x0, y0), (x0 + r * 0.34, cy), (x0, cy + r * 0.30)], fill=(16, 22, 46), width=w, joint='curve')
d.line([(cx + r * 0.02, cy + r * 0.30), (cx + r * 0.42, cy + r * 0.30)], fill=(16, 22, 46), width=w)
for p in ((x0, y0), (x0, cy + r * 0.30), (cx + r * 0.02, cy + r * 0.30), (cx + r * 0.42, cy + r * 0.30)):
    d.ellipse((p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2), fill=(16, 22, 46))

icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save(os.path.join(out, 'icon.png'))
for n in (512, 256, 128, 64, 32, 16):
    icon.resize((n, n), Image.LANCZOS).save(os.path.join(out, f'icon-{n}.png'))
print('ok', out)
