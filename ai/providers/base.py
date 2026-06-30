"""
EmbeddingProvider interface.

This is the seam that lets the AI model be replaced without touching billing
or product logic. A provider turns an RGB image into a single L2-normalized
vector. The web prototype uses a server-side DINOv2 provider; the Android
build will implement this same interface with an on-device MobileCLIP/TFLite
provider. Nothing above this interface knows which model is running.
"""
from __future__ import annotations

import abc

import numpy as np
from PIL import Image


class EmbeddingProvider(abc.ABC):
    #: Logical id stored with every vector; changing models means changing this.
    model_id: str
    #: Output vector dimensionality.
    dim: int

    @abc.abstractmethod
    def embed(self, image: Image.Image) -> np.ndarray:
        """Return a 1-D float32 vector of length `dim`."""

    @staticmethod
    def l2_normalize(vector: np.ndarray) -> np.ndarray:
        norm = np.linalg.norm(vector)
        if norm == 0:
            return vector.astype(np.float32)
        return (vector / norm).astype(np.float32)
