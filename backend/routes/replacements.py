"""Replacement / exchange endpoints."""
from __future__ import annotations

import io

from flask import Blueprint, request, send_file

from backend.services import replacement_service
from database.db import session_scope
from utils.validators import ValidationError
from utils.responses import error, ok

replacements_bp = Blueprint("replacements", __name__, url_prefix="/api/replacements")


@replacements_bp.get("")
def list_all():
    term = request.args.get("q")
    with session_scope() as s:
        return ok(replacement_service.list_replacements(s, term))


@replacements_bp.get("/today")
def today():
    with session_scope() as s:
        return ok(replacement_service.today_stats(s))


@replacements_bp.post("")
def create():
    body = request.get_json(silent=True) or {}
    if not body.get("returned_product_id"):
        return error("validation_error", "Please choose the returned product.")
    try:
        with session_scope() as s:
            r = replacement_service.create_replacement(
                s,
                returned_product_id=int(body["returned_product_id"]),
                returned_qty=int(body.get("returned_qty") or 1),
                replacement_product_id=(
                    int(body["replacement_product_id"])
                    if body.get("replacement_product_id") else None
                ),
                replacement_qty=int(body.get("replacement_qty") or 1),
                customer_name=body.get("customer_name"),
                mobile=body.get("mobile"),
                reason=body.get("reason"),
                payment_method=body.get("payment_method") or "cash",
                payment_split=body.get("payment_split"),
            )
        return ok(r, status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))
    except (TypeError, ValueError) as exc:
        return error("validation_error", str(exc))


@replacements_bp.get("/<int:rid>")
def get_one(rid: int):
    with session_scope() as s:
        r = replacement_service.get(s, rid)
    if not r:
        return error("not_found", "Replacement not found.", status=404)
    return ok(r)


@replacements_bp.delete("/<int:rid>")
def delete_one(rid: int):
    with session_scope() as s:
        okd = replacement_service.delete(s, rid)
    if not okd:
        return error("not_found", "Replacement not found.", status=404)
    return ok({"deleted": True, "message": "Replacement deleted (bill history unchanged)"})


@replacements_bp.get("/<int:rid>/pdf")
def receipt_pdf(rid: int):
    from backend.services import replacement_pdf

    with session_scope() as s:
        r = replacement_service.get(s, rid)
        if not r:
            return error("not_found", "Replacement not found.", status=404)
        pdf = replacement_pdf.build_receipt(r)
    return send_file(
        io.BytesIO(pdf), mimetype="application/pdf", as_attachment=True,
        download_name=f"{r['replacement_number']}.pdf",
    )
