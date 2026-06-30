"""
Settings endpoints: version info, database backup/export, and restore.

Backup/export download the SQLite file; restore replaces it (SQLite only).
Restore is deliberately blunt for v1 — full-file swap — and returns an error
on non-SQLite backends rather than pretending to support them.
"""
from __future__ import annotations

import datetime as _dt
from pathlib import Path

from flask import Blueprint, current_app, request, send_file

from config import settings
from utils.responses import error, ok

settings_bp = Blueprint("settings", __name__, url_prefix="/api/settings")


def _sqlite_path() -> Path | None:
    url = settings.DATABASE_URL
    if not url.startswith("sqlite:///"):
        return None
    return Path(url.replace("sqlite:///", "", 1))


@settings_bp.get("/info")
def info():
    from sqlalchemy import func, select
    from database.db import session_scope
    from database.models import Product

    recognizer = current_app.config["RECOGNIZER"]
    store = current_app.config["VECTOR_STORE"]
    with session_scope() as s:
        product_count = s.scalar(select(func.count(Product.id))) or 0
        from backend.services import inventory_service
        stock = inventory_service.counts(s)
    return ok(
        {
            "app": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "database": "sqlite" if _sqlite_path() else "external",
            "min_product_images": settings.MIN_PRODUCT_IMAGES,
            "max_product_images": settings.MAX_PRODUCT_IMAGES,
            "recognizer": recognizer.provider.model_id,
            "indexed_vectors": store.size(),
            "product_count": product_count,
            "low_stock": stock["low_stock"],
            "out_of_stock": stock["out_of_stock"],
        }
    )


@settings_bp.post("/reindex")
def reindex():
    """Re-embed every product's saved images under the active recognizer."""
    from ai.enrollment import reindex_all
    from database.db import session_scope

    recognizer = current_app.config["RECOGNIZER"]
    with session_scope() as s:
        result = reindex_all(s, recognizer)
    current_app.logger.info("Manual reindex: %s", result)
    return ok(result)


@settings_bp.get("/backup")
def backup():
    path = _sqlite_path()
    if path is None or not path.exists():
        return error("unsupported", "Backup is available for SQLite databases only.")
    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    return send_file(path, as_attachment=True, download_name=f"resvi_backup_{stamp}.db")


@settings_bp.post("/restore")
def restore():
    path = _sqlite_path()
    if path is None:
        return error("unsupported", "Restore is available for SQLite databases only.")
    upload = request.files.get("backup")
    if upload is None or not upload.filename:
        return error("validation_error", "No backup file supplied.")
    upload.save(path)
    return ok({"restored": True, "note": "Restart the application to load the restored data."})
