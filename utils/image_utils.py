"""
Image utilities: loading and the centered guide-box crop.

Kept dependency-light (Pillow only). Background removal is an optional hook
wired in preprocess.py so the heavy 'rembg' dependency stays out of the core.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image


def load_image(path: str | Path) -> Image.Image:
    img = Image.open(path)
    return img.convert("RGB")


def center_guide_crop(img: Image.Image, fraction: float) -> Image.Image:
    """Crop a centered square sized to `fraction` of the shorter side.

    Mirrors the on-screen guide box: the user places the object inside the
    box, and only that region is analyzed (one product at a time).
    """
    fraction = max(0.1, min(1.0, fraction))
    width, height = img.size
    side = int(min(width, height) * fraction)
    left = (width - side) // 2
    top = (height - side) // 2
    return img.crop((left, top, left + side, top + side))
