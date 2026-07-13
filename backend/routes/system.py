"""
System routes: health check and runtime information.

Exists so Phase 1 is verifiably running end to end and so the future Android
client has a stable endpoint to confirm server reachability and model identity.
"""
from __future__ import annotations

from flask import Blueprint, current_app

from config import ai_config, settings
from utils.responses import ok

system_bp = Blueprint("system", __name__, url_prefix="/api/system")


@system_bp.get("/health")
def health():
    return ok({"status": "up"})


@system_bp.get("/data-version")
def data_version():
    """A cheap fingerprint of shared data so devices can detect changes made by
    other devices (multi-device sync via polling). Any add/edit/stock/bill
    changes the fingerprint, prompting other clients to refresh."""
    from sqlalchemy import func, select
    from database.db import session_scope
    from database.models import Bill, DraftBill, Product, Replacement, StockMovement

    with session_scope() as s:
        products = s.scalar(select(func.count(Product.id))) or 0
        bills = s.scalar(select(func.count(Bill.id))) or 0
        movements = s.scalar(select(func.count(StockMovement.id))) or 0
        drafts = s.scalar(
            select(func.count(DraftBill.id)).where(DraftBill.status == "ACTIVE")
        ) or 0
        reps = s.scalar(select(func.count(Replacement.id))) or 0
        # Latest change timestamps (nullable-safe).
        last_bill = s.scalar(select(func.max(Bill.bill_date)))
        last_move = s.scalar(select(func.max(StockMovement.created_at)))
        last_draft = s.scalar(select(func.max(DraftBill.updated_at)))
    stamp = max([t for t in (last_bill, last_move, last_draft) if t is not None], default=None)
    fingerprint = f"{products}-{bills}-{movements}-{drafts}-{reps}-{stamp.isoformat() if stamp else '0'}"
    return ok({"version": fingerprint, "products": products, "bills": bills, "drafts": drafts})


@system_bp.get("/info")
def info():
    recognizer = current_app.config["RECOGNIZER"]
    store = current_app.config["VECTOR_STORE"]
    return ok(
        {
            "app": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "model_id": recognizer.provider.model_id,
            "embedding_dim": recognizer.provider.dim,
            "indexed_vectors": store.size(),
            "thresholds": {
                "auto_add": ai_config.AUTO_ADD_THRESHOLD,
                "confirm": ai_config.CONFIRM_THRESHOLD,
                "ambiguity_margin": ai_config.AMBIGUITY_MARGIN,
            },
        }
    )
