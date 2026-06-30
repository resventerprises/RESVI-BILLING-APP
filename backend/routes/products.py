"""Product endpoints: CRUD, search, status toggle, and image serving."""
from __future__ import annotations

from flask import Blueprint, current_app, request, send_file

from backend.services import product_service
from database.crud import repositories as repo
from database.db import session_scope
from utils.responses import error, ok
from utils.validators import ValidationError

products_bp = Blueprint("products", __name__, url_prefix="/api/products")


def _recognizer():
    return current_app.config["RECOGNIZER"]


@products_bp.get("")
def list_products():
    term = request.args.get("q")
    category_id = request.args.get("category_id", type=int)
    only_active = request.args.get("active") == "1"
    with session_scope() as s:
        items = product_service.search_products(
            s, term=term, category_id=category_id, only_active=only_active
        )
        return ok([product_service.serialize(p, s) for p in items])


@products_bp.post("")
def create_product():
    """Multipart form: name, category_id, selling_price, discount, family_key,
    and one or more 'images' file parts (>= MIN_PRODUCT_IMAGES)."""
    form = request.form
    files = request.files.getlist("images")
    image_sources = [(f.filename, f.read()) for f in files if f and f.filename]
    try:
        with session_scope() as s:
            product = product_service.create_product(
                s,
                _recognizer(),
                name=form.get("name"),
                category_id=form.get("category_id", type=int),
                selling_price=form.get("selling_price"),
                discount=form.get("discount", 0.0),
                cost_price=form.get("cost_price", 0.0),
                quantity=form.get("quantity", 0),
                min_stock_level=form.get("min_stock_level", 0),
                description=form.get("description"),
                family_key=form.get("family_key"),
                image_sources=image_sources,
            )
            return ok(product_service.serialize(product, s), status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.put("/<int:product_id>")
def update_product(product_id: int):
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            product = product_service.update_product(s, _recognizer(), product_id, **body)
            return ok(product_service.serialize(product, s))
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.delete("/<int:product_id>")
def delete_product(product_id: int):
    try:
        with session_scope() as s:
            product_service.delete_product(s, _recognizer(), product_id)
            return ok({"deleted": product_id})
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.get("/image/<int:image_id>")
def product_image(image_id: int):
    with session_scope() as s:
        image = repo.product_images.get(s, image_id)
        if image is None:
            return error("not_found", "Image not found.", status=404)
        path = image.image_path
    return send_file(path)
