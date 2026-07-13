"""Draft (held) bill endpoints."""
from __future__ import annotations

from flask import Blueprint, request

from backend.services import draft_service
from database.db import session_scope
from utils.responses import error, ok

drafts_bp = Blueprint("drafts", __name__, url_prefix="/api/drafts")


@drafts_bp.get("")
def list_drafts():
    term = request.args.get("q")
    with session_scope() as s:
        return ok(draft_service.list_active(s, term))


@drafts_bp.get("/count")
def count_drafts():
    with session_scope() as s:
        return ok({"active": draft_service.active_count(s)})


@drafts_bp.post("")
def create_draft():
    body = request.get_json(silent=True) or {}
    with session_scope() as s:
        d = draft_service.create(
            s,
            customer_name=body.get("customer_name"),
            payload=body.get("payload") or {},
            notes=body.get("notes"),
        )
    return ok(d, status=201)


@drafts_bp.get("/<int:draft_id>")
def get_draft(draft_id: int):
    with session_scope() as s:
        d = draft_service.get(s, draft_id)
    if not d:
        return error("not_found", "Draft not found.", status=404)
    return ok(d)


@drafts_bp.put("/<int:draft_id>")
def update_draft(draft_id: int):
    """Autosave: called whenever the cart changes."""
    body = request.get_json(silent=True) or {}
    with session_scope() as s:
        d = draft_service.update(
            s, draft_id,
            payload=body.get("payload"),
            customer_name=body.get("customer_name"),
            notes=body.get("notes"),
        )
    if not d:
        return error("not_found", "Draft not found.", status=404)
    return ok(d)


@drafts_bp.delete("/<int:draft_id>")
def delete_draft(draft_id: int):
    with session_scope() as s:
        okd = draft_service.delete(s, draft_id)
    if not okd:
        return error("not_found", "Draft not found.", status=404)
    return ok({"deleted": True, "message": "Draft deleted"})
