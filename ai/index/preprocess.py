"""
Preprocessing applied identically at enrollment and at scan time.

Keeping these in lockstep is what closes the studio-vs-counter domain gap:
the object the model sees when you enroll must be framed and (optionally)
background-stripped the same way as when you scan. Background removal is an
optional hook (rembg) so the core stays dependency-light.
"""
from __future__ import annotations

from PIL import Image

from config import ai_config
from utils.image_utils import center_guide_crop


def _maybe_remove_background(img: Image.Image) -> Image.Image:
    if not ai_config.REMOVE_BACKGROUND:
        return img
    try:
        from rembg import remove  # heavy optional dependency
    except ImportError:
        return img  # silently skip if extras not installed
    cut = remove(img)
    # Composite onto white so the model sees a clean, consistent backdrop.
    background = Image.new("RGB", cut.size, (255, 255, 255))
    background.paste(cut, mask=cut.split()[-1] if cut.mode == "RGBA" else None)
    return background


def preprocess(img: Image.Image, *, is_scan: bool) -> Image.Image:
    """Return the analysis-ready image.

    At scan time the guide-box crop isolates the single framed object.
    At enrollment the crop is applied too, so reference and query images
    share the same framing.
    """
    img = img.convert("RGB")
    img = center_guide_crop(img, ai_config.GUIDE_BOX_FRACTION)
    img = _maybe_remove_background(img)
    return img
