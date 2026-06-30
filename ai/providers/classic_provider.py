"""
Classic hand-crafted embedding provider (default).

The previous 'dummy' provider used only a downscaled grayscale signature, which
cannot tell real products apart — every live frame scored low, so nothing was
ever recognized. This provider builds a far more discriminative descriptor from
colour and coarse shape, using only numpy + Pillow (no torch download):

  * HSV hue/saturation 2-D histogram  -> colour identity
  * value (brightness) histogram       -> lighting/shade
  * downsampled luminance              -> coarse shape/layout

Each block is L2-normalized, concatenated, then L2-normalized again so cosine
similarity is meaningful. It is still a basic recognizer (DINOv2 is the
accurate path for look-alike stock), but it actually works for visually
distinct products and gives real, non-trivial scores to calibrate against.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .base import EmbeddingProvider

_H_BINS = 16
_S_BINS = 8
_V_BINS = 16
_GRID = 16  # luminance downsample -> 16x16


class ClassicEmbeddingProvider(EmbeddingProvider):
    model_id = "classic-v1"
    dim = _H_BINS * _S_BINS + _V_BINS + _GRID * _GRID  # 128 + 16 + 256 = 400

    def embed(self, image: Image.Image) -> np.ndarray:
        rgb = image.convert("RGB").resize((96, 96), Image.BILINEAR)
        hsv = np.asarray(rgb.convert("HSV"), dtype=np.float32)
        h, s, v = hsv[:, :, 0].ravel(), hsv[:, :, 1].ravel(), hsv[:, :, 2].ravel()

        # Colour: joint hue-saturation histogram (weighted by saturation so flat
        # greys don't dominate), plus a value histogram.
        hs, _, _ = np.histogram2d(
            h, s, bins=[_H_BINS, _S_BINS], range=[[0, 256], [0, 256]], weights=(s / 255.0)
        )
        hs = self._norm(hs.ravel())
        vh, _ = np.histogram(v, bins=_V_BINS, range=(0, 256))
        vh = self._norm(vh.astype(np.float32))

        # Shape: coarse luminance grid, mean-removed.
        lum = np.asarray(rgb.convert("L").resize((_GRID, _GRID), Image.BILINEAR), dtype=np.float32)
        lum = lum.ravel() - lum.mean()
        lum = self._norm(lum)

        vec = np.concatenate([hs * 1.0, vh * 0.5, lum * 1.0]).astype(np.float32)
        return self.l2_normalize(vec)

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        n = np.linalg.norm(x)
        return x / n if n > 0 else x
