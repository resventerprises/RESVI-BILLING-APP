"""Draft (held) bills — multiple bills in progress at the same time.

Drafts live in the database, not the browser, so they survive refreshes and app
restarts and are visible on every device. Stock is never reserved by a draft;
inventory only moves when the bill is completed.
"""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.services.timezone_util import ist_time_str, ist_date_str
from database.models import DraftBill

ACTIVE = "ACTIVE"
COMPLETED = "COMPLETED"
DELETED = "DELETED"


def _next_number(session: Session) -> str:
    """Draft #001, #002 ... — counts every draft ever made so numbers don't repeat."""
    n = session.scalar(select(func.count(DraftBill.id))) or 0
    return f"Draft #{n + 1:03d}"


def _totals(payload: dict) -> dict:
    """Item count and money totals from the stored cart payload."""
    lines = payload.get("lines") or []
    manual = payload.get("manual") or []
    count = sum(int(l.get("qty") or 0) for l in lines) + sum(int(m.get("qty") or 0) for m in manual)
    subtotal = 0.0
    for l in lines:
        price = float(l.get("price") or 0) - float(l.get("discount") or 0)
        subtotal += price * int(l.get("qty") or 0)
    for m in manual:
        subtotal += float(m.get("price") or 0) * int(m.get("qty") or 0)
    subtotal = round(subtotal, 2)

    # Same rules the cart uses: explicit final amount wins, else apply discount.
    final_amount = payload.get("finalAmount")
    if final_amount is not None:
        total = round(float(final_amount), 2)
    else:
        dtype = payload.get("discountType")
        dval = float(payload.get("discountValue") or 0)
        if dtype and dval:
            amt = round(subtotal * dval / 100, 2) if dtype == "percent" else dval
            amt = min(max(0.0, amt), subtotal)
        else:
            amt = 0.0
        total = round(subtotal - amt, 2)
    return {"item_count": count, "subtotal": subtotal, "total": total}


def _serialize(d: DraftBill) -> dict:
    try:
        payload = json.loads(d.payload or "{}")
    except (ValueError, TypeError):
        payload = {}
    t = _totals(payload)
    return {
        "id": d.id,
        "draft_number": d.draft_number,
        "customer_name": d.customer_name or "",
        "notes": d.notes or "",
        "status": d.status,
        "payload": payload,
        "item_count": t["item_count"],
        "subtotal": t["subtotal"],
        "total": t["total"],
        "created_time": ist_time_str(d.created_at),
        "created_date": ist_date_str(d.created_at),
        "updated_time": ist_time_str(d.updated_at),
    }


def create(session: Session, customer_name: str | None = None,
           payload: dict | None = None, notes: str | None = None) -> dict:
    d = DraftBill(
        draft_number=_next_number(session),
        customer_name=(customer_name or "").strip() or None,
        payload=json.dumps(payload or {}),
        notes=(notes or "").strip() or None,
        status=ACTIVE,
    )
    session.add(d)
    session.flush()
    return _serialize(d)


def list_active(session: Session, term: str | None = None) -> list[dict]:
    stmt = select(DraftBill).where(DraftBill.status == ACTIVE)
    if term:
        like = f"%{term.strip()}%"
        stmt = stmt.where(
            (DraftBill.customer_name.ilike(like)) | (DraftBill.draft_number.ilike(like))
        )
    stmt = stmt.order_by(DraftBill.updated_at.desc())
    return [_serialize(d) for d in session.scalars(stmt).all()]


def get(session: Session, draft_id: int) -> dict | None:
    d = session.get(DraftBill, draft_id)
    if not d or d.status != ACTIVE:
        return None
    return _serialize(d)


def update(session: Session, draft_id: int, *, payload: dict | None = None,
           customer_name: str | None = None, notes: str | None = None) -> dict | None:
    """Autosave target — called on every cart change."""
    d = session.get(DraftBill, draft_id)
    if not d or d.status != ACTIVE:
        return None
    if payload is not None:
        d.payload = json.dumps(payload)
    if customer_name is not None:
        d.customer_name = customer_name.strip() or None
    if notes is not None:
        d.notes = notes.strip() or None
    d.updated_at = datetime.utcnow()
    session.flush()
    return _serialize(d)


def delete(session: Session, draft_id: int) -> bool:
    """Soft-delete: the draft disappears from the list but bill history is
    untouched (a draft was never a bill)."""
    d = session.get(DraftBill, draft_id)
    if not d:
        return False
    d.status = DELETED
    return True


def mark_completed(session: Session, draft_id: int) -> bool:
    d = session.get(DraftBill, draft_id)
    if not d:
        return False
    d.status = COMPLETED
    return True


def active_count(session: Session) -> int:
    return session.scalar(
        select(func.count(DraftBill.id)).where(DraftBill.status == ACTIVE)
    ) or 0
