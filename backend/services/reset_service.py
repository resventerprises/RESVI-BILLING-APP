"""Reset all product data safely.

Wipes Products, Product Images, Product Embeddings, Stock Movements and Import
History — WITHOUT damaging any other business data. Categories, Bills, Cash
Drawer, Replacements, Drafts and Settings are all preserved.

The one subtlety: bill items and replacement records reference products by id and
read the product's *name* live. Before deleting products we snapshot each
product's name into those rows (item_name / returned_name / replacement_name) so
past bills and replacement history keep showing the correct names after the
products are gone. Then we null the product references and delete the products.
"""
from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from database.models import (
    BillItem,
    ImportBatch,
    Product,
    ProductEmbedding,
    ProductImage,
    Replacement,
    StockMovement,
)


def reset_product_data(session: Session, recognizer=None) -> dict:
    """Remove all products and their derived data. Returns a summary of counts.

    Order matters: snapshot names first, unlink references, then delete children
    and finally the products themselves.
    """
    # ---- Counts before, for the summary ----
    product_count = session.scalar(select(Product.id).limit(1)) is not None
    total_products = session.query(Product).count()
    total_images = session.query(ProductImage).count()
    total_embeddings = session.query(ProductEmbedding).count()
    total_batches = session.query(ImportBatch).count()

    # Map product_id -> name so bills / replacements keep readable names.
    names = {p.id: p.product_name for p in session.query(Product).all()}

    # ---- 1. Snapshot names into BILL ITEMS, then unlink ----
    bill_items = (
        session.query(BillItem).filter(BillItem.product_id.isnot(None)).all()
    )
    bill_items_updated = 0
    for it in bill_items:
        # Preserve the product name so the bill still reads correctly.
        if not it.item_name:
            it.item_name = names.get(it.product_id) or "(removed product)"
        it.product_id = None
        bill_items_updated += 1

    # ---- 2. Snapshot names into REPLACEMENT records, then unlink ----
    reps = session.query(Replacement).all()
    reps_updated = 0
    for r in reps:
        touched = False
        if r.returned_product_id is not None:
            if not r.returned_name:
                r.returned_name = names.get(r.returned_product_id) or "(removed product)"
            r.returned_product_id = None
            touched = True
        if r.replacement_product_id is not None:
            if not r.replacement_name:
                r.replacement_name = names.get(r.replacement_product_id) or "(removed product)"
            r.replacement_product_id = None
            touched = True
        if touched:
            reps_updated += 1

    session.flush()

    # ---- 3. Delete product-owned children explicitly (don't rely on cascade) ----
    session.query(ProductEmbedding).delete(synchronize_session=False)
    session.query(ProductImage).delete(synchronize_session=False)
    session.query(StockMovement).delete(synchronize_session=False)

    # ---- 4. Delete all products ----
    session.query(Product).delete(synchronize_session=False)

    # ---- 5. Delete all import history ----
    session.query(ImportBatch).delete(synchronize_session=False)

    session.flush()

    # ---- 6. Clear the AI recognition index (rebuilt as products are re-added) ----
    if recognizer is not None:
        try:
            recognizer.reset()
        except AttributeError:
            # Older recognizer without reset(): remove vectors one-by-one is moot
            # since embeddings are already deleted; the index rebuilds on enroll.
            pass

    return {
        "products_deleted": total_products,
        "images_deleted": total_images,
        "embeddings_deleted": total_embeddings,
        "import_batches_deleted": total_batches,
        "bill_items_preserved": bill_items_updated,
        "replacements_preserved": reps_updated,
    }
