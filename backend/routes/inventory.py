"""Inventory endpoints: stock list, stock-in, adjust, history, low-stock."""
from __future__ import annotations

from flask import Blueprint, request

from backend.services import inventory_service
from database.db import session_scope
from utils.responses import error, ok
from utils.validators import ValidationError

inventory_bp = Blueprint("inventory", __name__, url_prefix="/api/inventory")


@inventory_bp.get("")
def list_inventory():
    only_low = request.args.get("low") == "1"
    with session_scope() as s:
        return ok(inventory_service.inventory_list(s, only_low=only_low))


@inventory_bp.post("/stock-in")
def stock_in():
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            m = inventory_service.stock_in(
                s, int(body.get("product_id")), body.get("quantity"), body.get("remarks")
            )
            return ok({"id": m.id, "balance_after": m.balance_after}, status=201)
    except (ValidationError, TypeError, ValueError) as exc:
        return error("validation_error", str(exc))


@inventory_bp.post("/adjust")
def adjust():
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            m = inventory_service.adjust(
                s, int(body.get("product_id")), body.get("delta"), body.get("remarks")
            )
            return ok({"id": m.id, "balance_after": m.balance_after}, status=201)
    except (ValidationError, TypeError, ValueError) as exc:
        return error("validation_error", str(exc))


@inventory_bp.get("/history")
def history():
    product_id = request.args.get("product_id", type=int)
    with session_scope() as s:
        return ok(inventory_service.history(s, product_id))
