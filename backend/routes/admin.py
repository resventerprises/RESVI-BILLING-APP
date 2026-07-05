"""Admin/maintenance endpoints.

These are destructive, so they are POST-only and require an explicit confirm
token in the body. Never expose these without that guard — on a public URL an
unprotected reset could wipe the whole catalogue with a single stray request.
"""
from __future__ import annotations

from flask import Blueprint, current_app, request

from database.db import session_scope
from utils.responses import error, ok

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


@admin_bp.post("/reset-products")
def reset_products():
    """Delete ALL products, categories, and import history, and reset counters.

    Requires body: {"confirm": "RESET"}  (guard against accidental/automated calls)
    """
    body = request.get_json(silent=True) or {}
    if body.get("confirm") != "RESET":
        return error(
            "confirmation_required",
            'This will delete ALL products and categories. Resend with {"confirm": "RESET"} to proceed.',
            status=400,
        )

    from sqlalchemy import delete

    from database.models import (
        Bill,
        BillItem,
        Category,
        DailySale,
        ImportBatch,
        Product,
        ProductEmbedding,
        ProductImage,
        Sequence,
        StockMovement,
    )

    try:
        with session_scope() as s:
            # Delete children first to satisfy foreign keys, then parents.
            s.execute(delete(ProductEmbedding))
            s.execute(delete(ProductImage))
            s.execute(delete(StockMovement))
            s.execute(delete(BillItem))
            s.execute(delete(Bill))
            s.execute(delete(DailySale))
            s.execute(delete(Product))
            s.execute(delete(ImportBatch))
            s.execute(delete(Category))
            # Reset the monotonic counters (product codes, bill numbers, barcodes).
            s.execute(delete(Sequence))
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("reset-products failed")
        return error("reset_error", f"{type(exc).__name__}: {exc}", status=500)

    # The data-version fingerprint is computed live from row counts + timestamps,
    # so emptying the tables automatically changes it — every device's 5-second
    # poll will detect the change and refresh. No extra bump needed.
    current_app.logger.info("Database reset: all products, categories, imports cleared.")
    return ok({"success": True, "message": "Database reset successfully"})
