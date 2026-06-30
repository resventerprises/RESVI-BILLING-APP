"""
DINOv2 embedding provider (web prototype, server-side).

DINOv2 (ViT-B/14) is a strong off-the-shelf, frozen embedding model: good
fine-grained retrieval with no per-product training, which is exactly what the
"add product -> instantly recognizable, no Train button" requirement needs.

This module is import-safe even when torch is absent: the heavy imports happen
inside __init__, so the rest of the app loads with only the dummy provider
available. Install the ML extras (requirements-ml.txt) and set
RESVI_EMBEDDING_PROVIDER=dinov2 to activate it.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .base import EmbeddingProvider


class DINOv2EmbeddingProvider(EmbeddingProvider):
    model_id = "dinov2-vitb14"
    dim = 768

    def __init__(self, weights: str = "facebook/dinov2-base"):
        try:
            import torch
            from transformers import AutoImageProcessor, AutoModel
        except ImportError as exc:  # pragma: no cover - only when extras missing
            raise RuntimeError(
                "DINOv2 provider requires the ML extras. Install "
                "requirements-ml.txt (torch, transformers)."
            ) from exc

        self._torch = torch
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        self._processor = AutoImageProcessor.from_pretrained(weights)
        self._model = AutoModel.from_pretrained(weights).to(self._device).eval()

    def embed(self, image: Image.Image) -> np.ndarray:
        torch = self._torch
        inputs = self._processor(images=image, return_tensors="pt").to(self._device)
        with torch.no_grad():
            outputs = self._model(**inputs)
        # CLS token as the global image descriptor.
        cls = outputs.last_hidden_state[:, 0, :].squeeze(0)
        return self.l2_normalize(cls.cpu().numpy())
