# 生成扩展图标：绿色渐变圆角方块 + 白色刷新箭头
# 输出到 site-revival-extension/icons/ 下 16/48/128 三种尺寸

from PIL import Image, ImageDraw
import math
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site-revival-extension', 'icons')
os.makedirs(OUT, exist_ok=True)

TOP = (52, 211, 153)    # emerald 400
BOT = (5, 150, 105)     # emerald 600
WHITE = (255, 255, 255, 255)


def make(size):
    s = size * 4  # 4x 超采样后缩小，边缘平滑
    grad = Image.new('RGBA', (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / (s - 1)
        c = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (s, y)], fill=c)

    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=255)

    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    w = max(2, int(s * 0.085))
    pad = int(s * 0.27)
    d.arc([pad, pad, s - pad, s - pad], start=-40, end=225, fill=WHITE, width=w)

    # 在弧线末端画箭头（沿顺时针切线方向）
    cx = cy = s / 2
    r = (s - 2 * pad) / 2
    ang = math.radians(225)
    ex, ey = cx + r * math.cos(ang), cy + r * math.sin(ang)
    dx, dy = -math.sin(ang), math.cos(ang)
    a = s * 0.085   # 箭头长度
    b = s * 0.075   # 箭头半宽
    tip = (ex + dx * a, ey + dy * a)
    p1 = (ex + math.cos(ang) * b, ey + math.sin(ang) * b)
    p2 = (ex - math.cos(ang) * b, ey - math.sin(ang) * b)
    d.polygon([tip, p1, p2], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 48, 128):
    make(size).save(os.path.join(OUT, f'icon{size}.png'))
    print('ok', size)
