"""Cash drawer endpoints: status, open, close, expenses, history."""
from __future__ import annotations

from flask import Blueprint, request

from backend.services import cash_service
from database.db import session_scope
from utils.responses import error, ok

cash_bp = Blueprint("cash", __name__, url_prefix="/api/cash")


@cash_bp.get("/status")
def status():
    with session_scope() as s:
        return ok(cash_service.status(s))


@cash_bp.post("/open")
def open_day():
    body = request.get_json(silent=True) or {}
    try:
        opening = float(body.get("opening_cash", 0))
    except (TypeError, ValueError):
        return error("validation_error", "opening_cash must be a number.")
    if opening < 0:
        return error("validation_error", "Opening cash cannot be negative.")
    with session_scope() as s:
        return ok(cash_service.open_day(s, opening))


@cash_bp.post("/expenses")
def expenses():
    body = request.get_json(silent=True) or {}
    try:
        exp = float(body.get("cash_expenses", 0))
    except (TypeError, ValueError):
        return error("validation_error", "cash_expenses must be a number.")
    if exp < 0:
        return error("validation_error", "Expenses cannot be negative.")
    with session_scope() as s:
        return ok(cash_service.save_expenses(s, exp))


@cash_bp.post("/close")
def close_day():
    body = request.get_json(silent=True) or {}
    try:
        exp = float(body.get("cash_expenses", 0) or 0)
        actual = float(body.get("actual_cash"))
    except (TypeError, ValueError):
        return error("validation_error", "actual_cash must be a number.")
    if actual < 0 or exp < 0:
        return error("validation_error", "Amounts cannot be negative.")
    d = body.get("date") or cash_service.today_key()
    with session_scope() as s:
        return ok(cash_service.close_day(s, d, exp, actual))


@cash_bp.get("/history")
def history():
    with session_scope() as s:
        return ok(cash_service.history(s))


@cash_bp.get("/expenses/list")
def expenses_list():
    d = request.args.get("date") or cash_service.today_key()
    with session_scope() as s:
        return ok({"date": d, "expenses": cash_service.list_expenses(s, d)})


@cash_bp.post("/expenses/add")
def expenses_add():
    body = request.get_json(silent=True) or {}
    d = body.get("date") or cash_service.today_key()
    try:
        with session_scope() as s:
            item = cash_service.add_expense(s, d, body.get("description", ""), float(body.get("amount", 0)))
        return ok(item, status=201)
    except (TypeError, ValueError) as exc:
        return error("validation_error", str(exc))


@cash_bp.post("/expenses/<int:expense_id>/edit")
def expenses_edit(expense_id: int):
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            found = cash_service.edit_expense(s, expense_id, body.get("description", ""), float(body.get("amount", 0)))
        if not found:
            return error("not_found", "Expense not found.", status=404)
        return ok({"updated": True})
    except (TypeError, ValueError) as exc:
        return error("validation_error", str(exc))


@cash_bp.delete("/expenses/<int:expense_id>")
def expenses_delete(expense_id: int):
    with session_scope() as s:
        found = cash_service.delete_expense(s, expense_id)
    if not found:
        return error("not_found", "Expense not found.", status=404)
    return ok({"deleted": True})
