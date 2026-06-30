"""
Enrollment service — the "no Train Database button" path.

Saving a product enrolls its images: each image is embedded, the vector is
persisted (ProductEmbedding) AND added to the live index, so the product is
recognizable on the very next scan. There is no model training and no batch
step. Re-enrolling under a new model_id (after a model swap) is the same code
path; old vectors remain until you choose to drop them.

rebuild_index() reloads the index from the DB at startup, keeping SQLite as
the single source of truth.
"""
from __future__ import annotations

import json

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai.providers.base import EmbeddingProvider
from ai.index.vector_store import VectorRecord, VectorStore
from ai.recognizer import AIRecognizer
from config import ai_config
from database.models import Product, ProductEmbedding, ProductImage, Status
from utils.image_utils import load_image


def enroll_image(
    session: Session,
    recognizer: AIRecognizer,
    product: Product,
    image: ProductImage,
) -> ProductEmbedding:
    """Embed one product image, persist the vector, and add it to the index."""
    pil = load_image(image.image_path)
    vector = recognizer.vectorize(pil, is_scan=False)

    embedding = ProductEmbedding(
        product_id=product.id,
        image_id=image.id,
        model_id=recognizer.provider.model_id,
        dim=int(vector.shape[0]),
        vector=json.dumps(vector.tolist()),
    )
    session.add(embedding)
    session.flush()

    recognizer.add_vector(product.id, image.id, product.family_key, vector)
    return embedding


def rebuild_index(session: Session, provider: EmbeddingProvider, store: VectorStore) -> int:
    """Load all vectors for the active model into a fresh index. Returns count.

    Only ACTIVE products are indexed: inactive products must not surface in
    recognition (per Part 2), so they are simply left out of the index.
    """
    store.clear()
    stmt = (
        select(ProductEmbedding, Product.family_key)
        .join(Product, Product.id == ProductEmbedding.product_id)
        .where(ProductEmbedding.model_id == provider.model_id)
        .where(Product.status == Status.ACTIVE)
    )
    count = 0
    for embedding, family_key in session.execute(stmt):
        vector = np.asarray(json.loads(embedding.vector), dtype=np.float32)
        store.add(VectorRecord(embedding.product_id, embedding.image_id, family_key, vector))
        count += 1
    return count


def reindex_all(session: Session, recognizer: AIRecognizer) -> dict:
    """Re-embed every active product's saved images under the current model.

    This is how products migrate when the recognizer changes (e.g. dummy ->
    classic -> dinov2): the original photos are still on disk, so we simply
    re-run enrollment from them. Returns counts and any skipped files.
    """
    from sqlalchemy import delete, select as _select

    provider = recognizer.provider
    store = recognizer.store

    # Drop existing vectors for this model, then rebuild from the saved images.
    session.execute(
        delete(ProductEmbedding).where(ProductEmbedding.model_id == provider.model_id)
    )
    session.flush()
    store.clear()

    products = session.scalars(
        _select(Product).where(Product.status == Status.ACTIVE)
    ).all()

    embedded = 0
    skipped = 0
    for product in products:
        images = session.scalars(
            _select(ProductImage).where(ProductImage.product_id == product.id)
        ).all()
        for image in images:
            try:
                enroll_image(session, recognizer, product, image)
                embedded += 1
            except (FileNotFoundError, OSError):
                skipped += 1  # image file missing/unreadable
    return {
        "products": len(products),
        "embedded": embedded,
        "skipped": skipped,
        "model_id": provider.model_id,
    }
