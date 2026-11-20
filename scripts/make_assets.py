#!/usr/bin/env python3
"""Generate the bundled assets: the default "BAS KAR BHAI!" blast video and the icons.

Everything is synthesized from scratch (no third-party media), so the repo
stays free of copyright headaches.

Needs: Python 3 with Pillow, ffmpeg (with libx264 + aac) on PATH, and the
Noto Sans / Noto Sans Devanagari fonts (pass --font-dir if they live elsewhere).

    python3 scripts/make_assets.py
"""

import argparse
import math
import random
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"

W, H, FPS, SECONDS = 1280, 720, 30, 6.0
RATE = 44100

YELLOW = (255, 214, 10)
RED = (255, 45, 85)
INK = (20, 20, 20)
WHITE = (255, 255, 255)

HORNS = [(0.0, 0.55), (0.7, 1.25), (1.4, 2.1), (3.6, 4.0), (5.0, 5.6)]
SIREN = (2.1, 6.0)


def find_font(font_dir, *names):
    for name in names:
        for path in Path(font_dir).rglob(name):
            return str(path)
    raise SystemExit(f"Could not find any of {names} under {font_dir}")


# ---------------------------------------------------------------------------
# Audio


def in_any(t, spans):
    return any(a <= t < b for a, b in spans)


def envelope(t, start, end, attack=0.01, release=0.06):
    if t < start or t >= end:
        return 0.0
    return min(1.0, (t - start) / attack, (end - t) / release)


def saw(phase):
    return 2.0 * (phase % 1.0) - 1.0


def make_audio(path):
    n = int(SECONDS * RATE)
    siren_phase = 0.0
    samples = []
    rnd = random.Random(7)
    for i in range(n):
        t = i / RATE
        s = 0.0

        # Air horn: a detuned, slightly wobbly chord of saw waves.
        horn_env = max(envelope(t, a, b) for a, b in HORNS)
        if horn_env:
            wobble = 1 + 0.006 * math.sin(2 * math.pi * 6 * t)
            for f in (233.0, 294.0, 349.0, 466.0):
                s += 0.3 * saw(f * wobble * t) + 0.12 * saw(f * 1.004 * t)
            s *= horn_env

        # Siren: a square-ish tone sweeping up and down.
        siren_env = envelope(t, *SIREN, attack=0.15, release=0.2)
        freq = 900 + 380 * math.sin(2 * math.pi * 0.9 * (t - SIREN[0]))
        siren_phase += freq / RATE
        if siren_env:
            s += 0.85 * siren_env * math.tanh(3.5 * math.sin(2 * math.pi * siren_phase))

        # A pinch of noise for grit, then hard-ish saturation for loudness.
        s += 0.02 * (rnd.random() * 2 - 1)
        samples.append(math.tanh(1.8 * s))

    peak = max(abs(x) for x in samples) or 1.0
    gain = 0.97 / peak
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(x * gain * 32767)) for x in samples))


# ---------------------------------------------------------------------------
# Video


def hazard_border(draw, thickness=46, step=46):
    for y0, y1 in ((0, thickness), (H - thickness, H)):
        draw.rectangle([0, y0, W, y1], fill=YELLOW)
        for x in range(-H, W + H, step * 2):
            draw.polygon([(x, y1), (x + step, y1), (x + step + thickness, y0), (x + thickness, y0)], fill=INK)


def centered(draw, text, font, cy, fill, stroke=0, stroke_fill=INK, dx=0, dy=0):
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(((W - w) / 2 - box[0] + dx, cy - h / 2 - box[1] + dy), text, font=font, fill=fill,
              stroke_width=stroke, stroke_fill=stroke_fill)


def make_frames(fonts):
    rnd = random.Random(42)
    latin_cache, hindi = {}, ImageFont.truetype(fonts["hindi"], 92)
    sub = ImageFont.truetype(fonts["bold"], 46)

    for i in range(int(SECONDS * FPS)):
        t = i / FPS
        horn = in_any(t, HORNS)
        flash = (i // 3) % 2 == 0
        if horn:
            bg, fg, accent = (RED, WHITE, YELLOW) if flash else (YELLOW, INK, RED)
        else:
            bg, fg, accent = (INK, YELLOW, RED) if (i // 8) % 2 else (RED, WHITE, YELLOW)

        img = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(img)

        # Rotating "siren light" beams from the corners.
        for cx, cy, direction in ((0, H // 2, 1), (W, H // 2, -1)):
            angle = direction * t * 540
            for k in range(3):
                a = math.radians(angle + k * 120)
                pts = [(cx, cy)]
                for da in (-10, 10):
                    r = 1100
                    pts.append((cx + r * math.cos(a + math.radians(da)), cy + r * math.sin(a + math.radians(da))))
                d.polygon(pts, fill=tuple(int(c * 0.82 + a2 * 0.18) for c, a2 in zip(bg, accent)))

        hazard_border(d)

        # Big shouty title: pulses with the horn, shakes all the time.
        pulse = 1.0 + (0.12 * abs(math.sin(t * 2 * math.pi * 1.7)) if horn else 0.04 * math.sin(t * 9))
        size = int(128 * pulse)
        font = latin_cache.setdefault(size, ImageFont.truetype(fonts["black"], size))
        shake = 14 if horn else 6
        dx, dy = rnd.randint(-shake, shake), rnd.randint(-shake, shake)
        centered(d, "BAS KAR BHAI!", font, H * 0.36, fg, stroke=8, stroke_fill=INK if fg != INK else WHITE,
                 dx=dx, dy=dy)
        centered(d, "बस कर भाई!", hindi, H * 0.58, accent, stroke=5, dx=-dx // 2, dy=-dy // 2)

        if t > 1.4:
            line = "Close the tab. Go do your work." if (t < 4.2) else "Everyone around you heard that."
            centered(d, line, sub, H * 0.78, WHITE if bg != YELLOW else INK, stroke=4,
                     stroke_fill=INK if bg != YELLOW else WHITE)

        yield img.tobytes()


def make_video(fonts, out):
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "blast.wav"
        make_audio(wav)
        proc = subprocess.Popen(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                "-i", str(wav),
                "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart", "-shortest", str(out),
            ],
            stdin=subprocess.PIPE,
        )
        for frame in make_frames(fonts):
            proc.stdin.write(frame)
        proc.stdin.close()
        if proc.wait():
            raise SystemExit("ffmpeg failed")


# ---------------------------------------------------------------------------
# Icons


def make_icon(fonts, size, out):
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def octagon(r):
        return [(s / 2 + r * math.cos(math.radians(22.5 + 45 * k)), s / 2 + r * math.sin(math.radians(22.5 + 45 * k)))
                for k in range(8)]

    d.polygon(octagon(250), fill=INK)
    d.polygon(octagon(228), fill=WHITE)
    d.polygon(octagon(206), fill=RED)

    if size >= 48:
        font = ImageFont.truetype(fonts["black"], 190)
        text = "BAS"
    else:
        font = ImageFont.truetype(fonts["black"], 360)
        text = "!"
    box = d.textbbox((0, 0), text, font=font)
    d.text(((s - (box[2] - box[0])) / 2 - box[0], (s - (box[3] - box[1])) / 2 - box[1]), text, font=font, fill=WHITE)

    img.resize((size, size), Image.LANCZOS).save(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--font-dir", default="/usr/share/fonts")
    ap.add_argument("--skip-video", action="store_true")
    args = ap.parse_args()

    fonts = {
        "black": find_font(args.font_dir, "NotoSans-Black.ttf"),
        "bold": find_font(args.font_dir, "NotoSans-Bold.ttf"),
        "hindi": find_font(args.font_dir, "NotoSansDevanagari-Black.ttf", "NotoSansDevanagari-Bold.ttf"),
    }

    (EXT / "icons").mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        make_icon(fonts, size, EXT / "icons" / f"icon{size}.png")
    print("icons written")

    if not args.skip_video:
        (EXT / "media").mkdir(parents=True, exist_ok=True)
        make_video(fonts, EXT / "media" / "default.mp4")
        print("media/default.mp4 written")


if __name__ == "__main__":
    main()
