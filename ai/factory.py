"""
Provider factory: resolves the active EmbeddingProvider from config by name.

Adding a model = adding a branch here and a provider class. The rest of the
app asks for "the recognizer" and never names a model.
"""
from __future__ import annotations

from ai.providers.base import EmbeddingProvider
from config import ai_config


def build_provider(name: str | None = None) -> EmbeddingProvider:
    name = (name or ai_config.EMBEDDING_PROVIDER).lower()

    if name == "classic":
        from ai.providers.classic_provider import ClassicEmbeddingProvider

        return ClassicEmbeddingProvider()
    if name == "dummy":
        from ai.providers.dummy_provider import DummyEmbeddingProvider

        return DummyEmbeddingProvider()
    if name == "dinov2":
        from ai.providers.dinov2_provider import DINOv2EmbeddingProvider

        return DINOv2EmbeddingProvider()
    if name == "mobileclip":
        from ai.providers.mobileclip_provider import MobileCLIPEmbeddingProvider

        return MobileCLIPEmbeddingProvider()

    raise ValueError(f"Unknown embedding provider: {name!r}")
