"""
MobileCLIP embedding provider (Android / on-device target).

Placeholder for the fat-offline Android client. MobileCLIP-S0 matches the
original CLIP's accuracy at roughly 3x smaller and ~5x faster with ~3ms
latency, which makes on-device, offline recognition at the counter viable.

It is intentionally a stub in Phase 1 (web prototype). When the Android build
begins, this class wraps the TFLite/Core ML export and implements the same
EmbeddingProvider.embed contract, so the recognition and billing layers move
across unchanged.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .base import EmbeddingProvider


class MobileCLIPEmbeddingProvider(EmbeddingProvider):
    model_id = "mobileclip-s0"
    dim = 512

    def __init__(self, *_, **__):
        raise NotImplementedError(
            "MobileCLIP provider is the Android on-device target and is not "
            "wired in the web prototype phase."
        )

    def embed(self, image: Image.Image) -> np.ndarray:  # pragma: no cover
        raise NotImplementedError
