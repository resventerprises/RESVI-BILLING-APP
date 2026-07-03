"""Serves the single-page app shell. The SPA keeps cart state and the camera
alive across screens (the scanner must not restart between products)."""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, abort, render_template, send_file

from config import settings

web_bp = Blueprint("web", __name__)


@web_bp.get("/")
def index():
    return render_template("index.html")


@web_bp.get("/uploads/products/<path:filename>")
def uploaded_product_image(filename: str):
    """Serve a product image file directly by its stored path/filename.

    Supports image_path values like 'uploads/products/UNO_RED_BOX.jpeg' as well
    as the per-product subfolders RESVI writes (uploads/products/<id>/..). Path
    traversal is blocked by resolving against the uploads root.
    """
    root = Path(settings.UPLOAD_DIR).resolve()
    target = (root / filename).resolve()
    if root not in target.parents and target != root:
        abort(404)
    if not target.is_file():
        abort(404)
    return send_file(target)
