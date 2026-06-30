"""
AIRecognizer: the recognition decision layer.

Composes an EmbeddingProvider (which model) with a VectorStore (which index),
neither of which the billing/product code knows about. identify() turns a
camera crop into a decision the UI can act on directly:

    AUTO_ADD : add to bill, green tick + vibration
    CONFIRM  : show the suggestion + similar products, user picks one
    MANUAL   : "couldn't identify exactly" -> top-5 + search + add-new

Policy decided up front and enforced here, not left to the model:
  * thresholds come from ai_config (auto >= 0.88, confirm >= 0.70)
  * if the top score's lead over the runner-up is thinner than
    AMBIGUITY_MARGIN, a would-be AUTO_ADD is downgraded to CONFIRM
  * if the top two candidates share a family_key (same item, different size),
    we ALWAYS force CONFIRM with a variant flag, because a single frame cannot
    judge absolute size. This is the catalogue's #1 failure mode, handled as
    a rule rather than hoping the model resolves it.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from ai.index.preprocess import preprocess
from ai.index.vector_store import VectorRecord, VectorStore
from ai.providers.base import EmbeddingProvider
from config import ai_config


class Decision(str, enum.Enum):
    AUTO_ADD = "auto_add"
    CONFIRM = "confirm"
    MANUAL = "manual"


@dataclass(frozen=True)
class Candidate:
    product_id: int
    score: float
    family_key: str | None


@dataclass(frozen=True)
class RecognitionResult:
    decision: Decision
    candidates: list[Candidate]
    variant_disambiguation: bool = False
    top: Candidate | None = field(default=None)


class AIRecognizer:
    def __init__(self, provider: EmbeddingProvider, store: VectorStore):
        self.provider = provider
        self.store = store

    # --- enrollment helpers (vectors only; persistence handled in enrollment.py)
    def vectorize(self, image: Image.Image, *, is_scan: bool) -> np.ndarray:
        processed = preprocess(image, is_scan=is_scan)
        return self.provider.embed(processed)

    def add_vector(
        self, product_id: int, image_id: int, family_key: str | None, vector: np.ndarray
    ) -> None:
        self.store.add(VectorRecord(product_id, image_id, family_key, vector))

    def remove_product(self, product_id: int) -> None:
        self.store.remove_product(product_id)

    # --- recognition ---------------------------------------------------------
    def identify(self, image: Image.Image) -> RecognitionResult:
        query = self.vectorize(image, is_scan=True)
        hits = self.store.search(query, ai_config.TOP_K * 4)
        if not hits:
            return RecognitionResult(decision=Decision.MANUAL, candidates=[])

        # Aggregate per product: a product's score is its best-matching image.
        best: dict[int, Candidate] = {}
        for hit in hits:
            current = best.get(hit.product_id)
            if current is None or hit.score > current.score:
                best[hit.product_id] = Candidate(hit.product_id, hit.score, hit.family_key)

        candidates = sorted(best.values(), key=lambda c: c.score, reverse=True)
        candidates = candidates[: ai_config.TOP_K]
        top = candidates[0]
        runner_up = candidates[1] if len(candidates) > 1 else None

        # Immediate mode: add the single best match as soon as it clears the
        # floor — no confirm step, no variant prompt, no score gating.
        if ai_config.IMMEDIATE_MODE:
            decision = (
                Decision.AUTO_ADD if top.score >= ai_config.CONFIRM_THRESHOLD else Decision.MANUAL
            )
            return RecognitionResult(
                decision=decision,
                candidates=candidates,
                variant_disambiguation=False,
                top=top,
            )

        # Variant rule: same family in the top two -> never auto-add.
        same_family = (
            runner_up is not None
            and top.family_key is not None
            and top.family_key == runner_up.family_key
        )

        decision = self._classify(top, runner_up, same_family)
        return RecognitionResult(
            decision=decision,
            candidates=candidates,
            variant_disambiguation=same_family,
            top=top,
        )

    @staticmethod
    def _classify(top: Candidate, runner_up: Candidate | None, same_family: bool) -> Decision:
        if top.score < ai_config.CONFIRM_THRESHOLD:
            return Decision.MANUAL
        if top.score < ai_config.AUTO_ADD_THRESHOLD:
            return Decision.CONFIRM
        # top score is in auto-add range from here on
        if same_family:
            return Decision.CONFIRM
        if runner_up is not None and (top.score - runner_up.score) < ai_config.AMBIGUITY_MARGIN:
            return Decision.CONFIRM
        return Decision.AUTO_ADD
