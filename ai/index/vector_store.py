"""
Vector store: the searchable index of product image embeddings.

Interface + a dependency-free NumpyVectorStore that does exact cosine search.
That is correct and fast enough for a single shop's catalogue (well under
~50k vectors). When the catalogue or latency demands it, drop in a
FaissVectorStore implementing the same interface, or pgvector after the
Postgres migration — nothing above this interface changes.

Each vector carries metadata (product_id, image_id, family_key) so the
recognizer can aggregate per product and apply the variant rule.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class VectorRecord:
    product_id: int
    image_id: int
    family_key: str | None
    vector: np.ndarray  # assumed L2-normalized


@dataclass(frozen=True)
class SearchHit:
    product_id: int
    image_id: int
    family_key: str | None
    score: float  # cosine similarity


class VectorStore(abc.ABC):
    @abc.abstractmethod
    def add(self, record: VectorRecord) -> None: ...

    @abc.abstractmethod
    def remove_product(self, product_id: int) -> None: ...

    @abc.abstractmethod
    def search(self, query: np.ndarray, top_k: int) -> list[SearchHit]: ...

    @abc.abstractmethod
    def clear(self) -> None: ...

    @abc.abstractmethod
    def size(self) -> int: ...


class NumpyVectorStore(VectorStore):
    """Exact cosine search over normalized vectors held in memory.

    The DB (ProductEmbedding rows) is the source of truth; this index is
    rebuilt from it at startup via enrollment.rebuild_index().
    """

    def __init__(self) -> None:
        self._records: list[VectorRecord] = []
        self._matrix: np.ndarray | None = None  # (N, dim), rebuilt lazily
        self._dirty = False

    def add(self, record: VectorRecord) -> None:
        self._records.append(record)
        self._dirty = True

    def remove_product(self, product_id: int) -> None:
        self._records = [r for r in self._records if r.product_id != product_id]
        self._dirty = True

    def clear(self) -> None:
        self._records = []
        self._matrix = None
        self._dirty = False

    def size(self) -> int:
        return len(self._records)

    def _ensure_matrix(self) -> None:
        if self._dirty or self._matrix is None:
            if self._records:
                self._matrix = np.vstack([r.vector for r in self._records])
            else:
                self._matrix = None
            self._dirty = False

    def search(self, query: np.ndarray, top_k: int) -> list[SearchHit]:
        self._ensure_matrix()
        if self._matrix is None:
            return []
        # Vectors are normalized, so dot product == cosine similarity.
        scores = self._matrix @ query.astype(np.float32)
        top_k = min(top_k, len(self._records))
        idx = np.argpartition(-scores, top_k - 1)[:top_k]
        idx = idx[np.argsort(-scores[idx])]
        hits: list[SearchHit] = []
        for i in idx:
            rec = self._records[int(i)]
            hits.append(
                SearchHit(
                    product_id=rec.product_id,
                    image_id=rec.image_id,
                    family_key=rec.family_key,
                    score=float(scores[int(i)]),
                )
            )
        return hits
