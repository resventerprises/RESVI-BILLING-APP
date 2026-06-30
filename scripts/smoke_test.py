"""
Phase 1 smoke test — proves the plumbing end to end with the dummy provider.

Run from the project root:  python scripts/smoke_test.py

Exercises:
  * table creation
  * non-reusable product code + bill number generation
  * enroll-on-save (vector persisted AND indexed, no training step)
  * identify() with AUTO_ADD on a distinctive item
  * the forced variant rule: two same-family size variants -> CONFIRM, not auto
  * index rebuild from the DB (SQLite as source of truth)

It uses synthetic images so it needs no real photos. This validates wiring and
policy, not recognition accuracy (that arrives with the DINOv2 provider).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the project root importable when run as a script.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
from PIL import Image

from ai.enrollment import enroll_image, rebuild_index
from ai.factory import build_provider
from ai.index.vector_store import NumpyVectorStore
from ai.recognizer import AIRecognizer, Decision
from backend.services.code_generator import next_bill_number, next_product_code
from config import settings
from database.db import init_db, session_scope
from database.models import Category, Product, ProductImage, Status

IMG_DIR = settings.UPLOAD_DIR / "_smoke"


def _make_image(path: Path, base: int, noise: int = 0) -> None:
    """Create a deterministic synthetic image with a distinctive pattern."""
    rng = np.random.default_rng(base)
    arr = rng.integers(base % 200, (base % 200) + 40, size=(128, 128, 3), dtype=np.uint8)
    if noise:
        arr = np.clip(arr.astype(int) + rng.integers(-noise, noise, arr.shape), 0, 255).astype(
            np.uint8
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path)


def main() -> int:
    init_db()
    settings.ensure_runtime_dirs()

    provider = build_provider("dummy")
    store = NumpyVectorStore()
    recognizer = AIRecognizer(provider, store)

    with session_scope() as session:
        # --- code generation: must be sequential and unique --------------
        codes = [next_product_code(session) for _ in range(3)]
        assert codes == ["P000001", "P000002", "P000003"], codes
        bills = [next_bill_number(session) for _ in range(2)]
        assert bills == ["BILL-000001", "BILL-000002"], bills
        print(f"[ok] product codes {codes}")
        print(f"[ok] bill numbers {bills}")

        category = Category(category_name="Kitchen Essentials", status=Status.ACTIVE)
        session.add(category)
        session.flush()

        # Distinctive product (a toy) -------------------------------------
        toy = Product(
            product_code=next_product_code(session),
            product_name="Wooden Toy Car",
            category_id=category.id,
            selling_price=149.0,
            family_key=None,
        )
        # Two SIZE VARIANTS sharing a family_key (the disambiguation case) -
        bucket_s = Product(
            product_code=next_product_code(session),
            product_name="Plastic Bucket 5L",
            category_id=category.id,
            selling_price=99.0,
            family_key="bucket-round-blue",
        )
        bucket_l = Product(
            product_code=next_product_code(session),
            product_name="Plastic Bucket 10L",
            category_id=category.id,
            selling_price=149.0,
            family_key="bucket-round-blue",
        )
        session.add_all([toy, bucket_s, bucket_l])
        session.flush()

        # Enroll images. Buckets get near-identical signatures (same family,
        # only size differs -> a frame can't tell them apart). Toy is distinct.
        def enroll(product: Product, base: int, n: int = 5, noise: int = 4) -> Path:
            first = None
            for i in range(n):
                p = IMG_DIR / f"{product.id}_{i}.png"
                _make_image(p, base, noise)
                if first is None:
                    first = p
                img = ProductImage(product_id=product.id, image_path=str(p), image_type="enroll")
                session.add(img)
                session.flush()
                enroll_image(session, recognizer, product, img)
            return first

        toy_ref = enroll(toy, base=17)
        # Same base => the two buckets look alike (real size variants do);
        # only their size/price differ, which a single frame cannot see.
        enroll(bucket_s, base=140)
        enroll(bucket_l, base=140)
        print(f"[ok] enrolled 3 products, index holds {store.size()} vectors")

        # --- identify the distinctive toy: expect AUTO_ADD ---------------
        result = recognizer.identify(Image.open(toy_ref).convert("RGB"))
        print(f"[..] toy scan -> {result.decision.value} "
              f"(top score {result.top.score:.3f}, product_id {result.top.product_id})")
        assert result.top.product_id == toy.id, "toy should be the top match"
        assert result.decision == Decision.AUTO_ADD, result.decision

        # --- identify a bucket: expect CONFIRM via the variant rule ------
        bucket_scan = IMG_DIR / "scan_bucket.png"
        _make_image(bucket_scan, base=140, noise=4)
        result = recognizer.identify(Image.open(bucket_scan).convert("RGB"))
        print(f"[..] bucket scan -> {result.decision.value} "
              f"(variant={result.variant_disambiguation}, "
              f"top score {result.top.score:.3f})")
        assert result.variant_disambiguation, "same-family buckets must flag variant"
        assert result.decision == Decision.CONFIRM, result.decision

        # --- rebuild index from DB: source-of-truth check ----------------
        reloaded = rebuild_index(session, provider, store)
        print(f"[ok] index rebuilt from DB -> {reloaded} vectors")
        assert reloaded == store.size() == 15, (reloaded, store.size())

    print("\nALL PHASE 1 CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
