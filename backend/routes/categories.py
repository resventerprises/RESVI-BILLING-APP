"""Category endpoints."""
from __future__ import annotations

from flask import Blueprint, request

from backend.services import category_service
from database.db import session_scope
from utils.responses import error, ok
from utils.validators import ValidationError

categories_bp = Blueprint("categories", __name__, url_prefix="/api/categories")


def _serialize(c) -> dict:
    return {
        "id": c.id,
        "category_name": c.category_name,
        "category_icon": c.category_icon,
        "status": c.status.value,
    }


@categories_bp.get("")
def list_categories():
    only_active = request.args.get("active") == "1"
    with session_scope() as s:
        return ok([_serialize(c) for c in category_service.list_categories(s, only_active)])


@categories_bp.post("")
def create_category():
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            c = category_service.create_category(s, body.get("name"), body.get("icon"))
            return ok(_serialize(c), status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))


@categories_bp.put("/<int:category_id>")
def update_category(category_id: int):
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            c = category_service.update_category(s, category_id, **body)
            return ok(_serialize(c))
    except ValidationError as exc:
        return error("validation_error", str(exc))


@categories_bp.delete("/<int:category_id>")
def delete_category(category_id: int):
    try:
        with session_scope() as s:
            category_service.delete_category(s, category_id)
            return ok({"deleted": category_id})
    except ValidationError as exc:
        return error("validation_error", str(exc))
