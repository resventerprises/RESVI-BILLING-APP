"""Scan, billing, history and daily-sales endpoints."""
from __future__ import annotations

from flask import Blueprint, current_app, request

from backend.services import billing_service, sales_service, scan_service
from database.db import session_scope
from utils.responses import error, ok
from utils.validators import ValidationError

scan_bp = Blueprint("scan", __name__, url_prefix="/api/scan")
billing_bp = Blueprint("billing", __name__, url_prefix="/api/bills")
sales_bp = Blueprint("sales", __name__, url_prefix="/api/sales")


@scan_bp.post("")
def scan():
    """Multipart 'frame' (image) OR raw image body. Returns a recognition
    decision with hydrated candidates."""
    if "frame" in request.files:
        image_bytes = request.files["frame"].read()
    else:
        image_bytes = request.get_data()
    if not image_bytes:
        return error("validation_error", "No image frame supplied.")
    try:
        with session_scope() as s:
            result = scan_service.scan_frame(s, current_app.config["RECOGNIZER"], image_bytes)
            return ok(result)
    except Exception as exc:  # surface, don't swallow — the client shows this
        current_app.logger.exception("Scan failed")
        return error("scan_error", f"{type(exc).__name__}: {exc}", status=500)


@billing_bp.post("/complete")
def complete():
    body = request.get_json(silent=True) or {}
    items = body.get("items", [])
    payment_method = body.get("payment_method", "cash")
    final_amount = body.get("final_amount", None)
    manual_items = body.get("manual_items", None)
    try:
        with session_scope() as s:
            bill = billing_service.complete_bill(s, items, payment_method, final_amount=final_amount, manual_items=manual_items)
            return ok(billing_service.serialize_bill(bill, s, with_items=True), status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))


@billing_bp.get("")
def history():
    limit = request.args.get("limit", default=50, type=int)
    with session_scope() as s:
        return ok(sales_service.bill_history(s, limit))


@billing_bp.get("/<int:bill_id>")
def detail(bill_id: int):
    try:
        with session_scope() as s:
            return ok(sales_service.bill_detail(s, bill_id))
    except ValidationError as exc:
        return error("not_found", str(exc), status=404)


@billing_bp.delete("/<int:bill_id>")
def delete_one(bill_id: int):
    """Permanently delete a bill; restores its sold stock. Reports update live."""
    from backend.services import bill_delete_service

    with session_scope() as s:
        okd = bill_delete_service.delete_bill(s, bill_id)
    if not okd:
        return error("not_found", "Bill not found.", status=404)
    return ok({"deleted": 1, "message": "Bill deleted"})


@sales_bp.get("/daily")
def daily():
    limit = request.args.get("limit", default=30, type=int)
    with session_scope() as s:
        return ok(sales_service.daily_sales(s, limit))


@sales_bp.delete("/daily/<sale_date>")
def delete_daily(sale_date: str):
    """Delete a daily sales entry = delete that date's bills (stock restored,
    reports/aggregates auto-update). Products/categories/imports untouched."""
    from datetime import datetime

    from backend.services import bill_delete_service
    from database.models import DailySale

    try:
        d = datetime.strptime(sale_date, "%Y-%m-%d").date()
    except ValueError:
        return error("validation_error", "date must be YYYY-MM-DD.")
    with session_scope() as s:
        n = bill_delete_service.delete_by_date(s, d)
        # Safety net: ensure the aggregate row for this exact key is gone even
        # if no bills matched (e.g. an orphaned row from earlier bugs).
        row = s.query(DailySale).filter(DailySale.sale_date == sale_date).first()
        if row is not None:
            s.delete(row)
    return ok({"deleted_bills": n, "message": f"Cleared sales for {d.strftime('%d-%m-%Y')}"})


@sales_bp.post("/daily/clear-today")
def clear_today_sales():
    from backend.services import bill_delete_service

    with session_scope() as s:
        n = bill_delete_service.clear_today(s)
    return ok({"deleted_bills": n, "message": f"Cleared today's sales ({n} bills)"})
