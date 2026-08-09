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
customers_bp = Blueprint("customers", __name__, url_prefix="/api/customers")


@customers_bp.get("")
def customers_list():
    from backend.services import customer_service
    with session_scope() as s:
        return ok(customer_service.search(s, request.args.get("q")))


@customers_bp.get("/lookup")
def customers_lookup():
    """Look up a customer by exact mobile — used to prefill the name field."""
    from backend.services import customer_service
    mobile = request.args.get("mobile", "")
    with session_scope() as s:
        return ok(customer_service.lookup_by_mobile(s, mobile) or {})


@customers_bp.get("/history")
def customers_history():
    """All bills + totals for a phone number (server-side)."""
    from backend.services import customer_service
    mobile = request.args.get("mobile", "")
    with session_scope() as s:
        return ok(customer_service.purchase_history(s, mobile))


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
    payment_split = body.get("payment_split", None)
    discount_type = body.get("discount_type", None)
    discount_value = body.get("discount_value", None)
    customer_name = body.get("customer_name", None)
    customer_mobile = body.get("customer_mobile", None)
    draft_id = body.get("draft_id", None)
    try:
        with session_scope() as s:
            bill = billing_service.complete_bill(s, items, payment_method, final_amount=final_amount, manual_items=manual_items, payment_split=payment_split, discount_type=discount_type, discount_value=discount_value, customer_name=customer_name, customer_mobile=customer_mobile)
            # A held bill that gets paid moves out of Drafts into Bill History.
            if draft_id:
                from backend.services import draft_service
                draft_service.mark_completed(s, int(draft_id))
            return ok(billing_service.serialize_bill(bill, s, with_items=True), status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))


@billing_bp.get("")
def history():
    """Bill history with optional date-range, bill-number search and pagination.

    Query params: from, to (YYYY-MM-DD IST), q (bill number), limit, offset.
    Latest bills first. Backward compatible: with no params, returns recent bills.
    """
    from backend.services import sales_service

    args = request.args
    with session_scope() as s:
        return ok(sales_service.bill_history_filtered(
            s,
            date_from=args.get("from"),
            date_to=args.get("to"),
            query=args.get("q"),
            limit=args.get("limit", default=50, type=int),
            offset=args.get("offset", default=0, type=int),
        ))


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


@billing_bp.put("/<int:bill_id>/payment-method")
def edit_payment_method(bill_id: int):
    """Correct ONLY the payment method (and split amounts) on a completed bill."""
    from backend.services import billing_service

    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            updated = billing_service.update_payment_method(
                s, bill_id,
                body.get("payment_method"),
                payment_split=body.get("payment_split"),
            )
        return ok({"bill": updated, "message": "Bill updated successfully"})
    except ValidationError as exc:
        return error("validation_error", str(exc), status=400)


@billing_bp.get("/<int:bill_id>/payment-edits")
def payment_edit_log(bill_id: int):
    from backend.services import billing_service

    with session_scope() as s:
        return ok(billing_service.payment_edit_history(s, bill_id))


@sales_bp.get("/manual")
def manual_get():
    from backend.services import manual_sales_service
    date = request.args.get("date")
    with session_scope() as s:
        if date:
            return ok(manual_sales_service.get_for_date(s, date) or {})
        return ok(manual_sales_service.list_all(s))


@sales_bp.post("/manual")
def manual_save():
    from backend.services import manual_sales_service
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            r = manual_sales_service.upsert(
                s, body.get("date"), body.get("amount"),
                note=body.get("note"), created_by=body.get("created_by"),
            )
        return ok({"entry": r, "message": "Manual sales entry saved"})
    except ValidationError as exc:
        return error("validation_error", str(exc), status=400)


@sales_bp.delete("/manual/<sale_date>")
def manual_delete(sale_date: str):
    from backend.services import manual_sales_service
    with session_scope() as s:
        okd = manual_sales_service.delete_for_date(s, sale_date)
    if not okd:
        return error("not_found", "No manual entry for that date.", status=404)
    return ok({"deleted": True, "message": "Manual sales entry deleted"})


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
