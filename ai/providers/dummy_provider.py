"""
Deterministic dummy embedding provider.

Purpose: make the entire enroll -> index -> identify pipeline runnable and
testable in Phase 1 without downloading torch/DINOv2. It produces a stable
vector from a downscaled grayscale signature of the image, so visually similar
images land near each other and identical images match exactly. It is NOT a
real recognizer — it exists to validate plumbing, thresholds, and the variant
logic end to end. Swap to the DINOv2 provider for real accuracy.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .base import EmbeddingProvider


class DummyEmbeddingProvider(EmbeddingProvider):
    model_id = "dummy-v1"
    dim = 256

    def __init__(self, dim: int = 256):
        self.dim = dim
        self._side = int(dim ** 0.5)  # 16 for dim=256
        if self._side * self._side != dim:
            raise ValueError("Dummy provider dim must be a perfect square.")

    def embed(self, image: Image.Image) -> np.ndarray:
        small = image.convert("L").resize((self._side, self._side), Image.BILINEAR)
        vector = np.asarray(small, dtype=np.float32).flatten()
        vector = vector - vector.mean()  # remove brightness offset
        return self.l2_normalize(vector)
