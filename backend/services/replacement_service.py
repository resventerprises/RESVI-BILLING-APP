"""Product replacement / exchange and refunds.

Money rules (difference = new_amount - old_amount):
  difference > 0  -> customer PAYS the difference. A Bill is created for exactly
                     that amount (as a manual line), so it appears in Bill History
                     and, if paid in cash, flows into the cash drawer normally.
  difference < 0  -> customer is REFUNDED. Cash goes OUT of the drawer.
  no new product  -> full refund of the returned item (REFUND_ONLY).

Inventory: returned item goes back IN, replacement item goes OUT. The bill we
create uses a manual line (not the product), so stock is never double-counted.
"""
from __future__ import annotations

import json
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.services import inventory_service
from backend.services.timezone_util import IST, ist_date_key, ist_date_str, ist_time_str
from database.crud import repositories as repo
from database.models import Product, Replacement
from utils.validators import ValidationError


def _next_number(session: Session) -> str:
    n = session.scalar(select(func.count(Replacement.id))) or 0
    return f"REP-{n + 1:06d}"


def _serialize(r: Replacement) -> dict:
    breakdown = None
    if r.payment_breakdown:
        try:
            breakdown = json.loads(r.payment_breakdown)
        except (ValueError, TypeError):
            breakdown = None
    return {
        "id": r.id,
        "replacement_number": r.replacement_number,
        "date": ist_date_str(r.created_at),
        "time": ist_time_str(r.created_at),
        "customer_name": r.customer_name or "",
        "mobile": r.mobile or "",
        "reason": r.reason or "",
        "returned_name": r.returned_name,
        "returned_qty": r.returned_qty,
        "returned_price": round(r.returned_price or 0, 2),
        "old_amount": round(r.old_amount or 0, 2),
        "replacement_name": r.replacement_name or "",
        "replacement_qty": r.replacement_qty or 0,
        "replacement_price": round(r.replacement_price or 0, 2),
        "new_amount": round(r.new_amount or 0, 2),
        "difference": round(r.difference or 0, 2),
        "collected_amount": round(r.collected_amount or 0, 2),
        "refund_amount": round(r.refund_amount or 0, 2),
        "payment_method": r.payment_method or "",
        "payment_breakdown": breakdown,
        "bill_id": r.bill_id,
        "kind": r.kind,
    }


def create_replacement(
    session: Session,
    *,
    returned_product_id: int,
    returned_qty: int = 1,
    replacement_product_id: int | None = None,
    replacement_qty: int = 1,
    customer_name: str | None = None,
    mobile: str | None = None,
    reason: str | None = None,
    payment_method: str = "cash",
    payment_split: dict | None = None,
) -> dict:
    from backend.services import billing_service

    returned = session.get(Product, returned_product_id)
    if not returned:
        raise ValidationError("Returned product not found.")
    returned_qty = int(returned_qty or 1)
    if returned_qty < 1:
        raise ValidationError("Returned quantity must be at least 1.")

    old_price = float(returned.selling_price or 0)
    old_amount = round(old_price * returned_qty, 2)

    new_product = None
    new_amount = 0.0
    new_price = 0.0
    replacement_qty = int(replacement_qty or 0)
    if replacement_product_id:
        new_product = session.get(Product, replacement_product_id)
        if not new_product:
            raise ValidationError("Replacement product not found.")
        if replacement_qty < 1:
            replacement_qty = 1
        if (new_product.quantity or 0) < replacement_qty:
            raise ValidationError(
                f"Not enough stock for {new_product.product_name} "
                f"(available {new_product.quantity or 0})."
            )
        new_price = float(new_product.selling_price or 0)
        new_amount = round(new_price * replacement_qty, 2)
    else:
        replacement_qty = 0

    difference = round(new_amount - old_amount, 2)
    collected = round(difference, 2) if difference > 0 else 0.0
    refund = round(-difference, 2) if difference < 0 else 0.0
    kind = "EXCHANGE" if new_product else "REFUND_ONLY"

    # ---- Inventory: returned item back IN, replacement item OUT ----
    inventory_service.adjust(
        session, returned.id, returned_qty,
        remarks=f"Replacement return: {returned.product_name}",
    )
    if new_product:
        inventory_service.adjust(
            session, new_product.id, -replacement_qty,
            remarks=f"Replacement issue: {new_product.product_name}",
        )

    # ---- Money ----
    bill = None
    breakdown_json = None
    if collected > 0:
        # Customer pays the difference: a real bill for exactly that amount.
        # A MANUAL line is used so inventory isn't deducted twice.
        label = f"Replacement: {returned.product_name} \u2192 {new_product.product_name}"
        bill = billing_service.complete_bill(
            session,
            [],
            payment_method,
            manual_items=[{"name": label[:190], "price": collected, "quantity": 1}],
            payment_split=payment_split,
        )
        if getattr(bill, "payment_breakdown", None):
            breakdown_json = bill.payment_breakdown

    r = Replacement(
        replacement_number=_next_number(session),
        customer_name=(customer_name or "").strip() or None,
        mobile=(mobile or "").strip() or None,
        reason=(reason or "").strip() or None,
        returned_product_id=returned.id,
        returned_name=returned.product_name,
        returned_qty=returned_qty,
        returned_price=old_price,
        old_amount=old_amount,
        replacement_product_id=new_product.id if new_product else None,
        replacement_name=new_product.product_name if new_product else None,
        replacement_qty=replacement_qty,
        replacement_price=new_price,
        new_amount=new_amount,
        difference=difference,
        collected_amount=collected,
        refund_amount=refund,
        payment_method=(payment_method if collected > 0 else ("cash" if refund > 0 else None)),
        payment_breakdown=breakdown_json,
        bill_id=bill.id if bill else None,
        kind=kind,
    )
    session.add(r)
    session.flush()
    return _serialize(r)


def list_replacements(session: Session, term: str | None = None, limit: int = 200) -> list[dict]:
    stmt = select(Replacement)
    if term:
        like = f"%{term.strip()}%"
        stmt = stmt.where(
            (Replacement.customer_name.ilike(like))
            | (Replacement.replacement_number.ilike(like))
            | (Replacement.mobile.ilike(like))
            | (Replacement.returned_name.ilike(like))
            | (Replacement.replacement_name.ilike(like))
        )
    stmt = stmt.order_by(Replacement.created_at.desc()).limit(limit)
    return [_serialize(r) for r in session.scalars(stmt).all()]


def get(session: Session, rid: int) -> dict | None:
    r = session.get(Replacement, rid)
    return _serialize(r) if r else None


def delete(session: Session, rid: int) -> bool:
    """Delete a replacement record. Reverses its inventory movement. The bill it
    created (if any) is left alone in Bill History — old bills are never touched."""
    r = session.get(Replacement, rid)
    if not r:
        return False
    # Reverse inventory: take the returned item back out, put the replacement back.
    if r.returned_product_id:
        inventory_service.adjust(
            session, r.returned_product_id, -(r.returned_qty or 0),
            remarks=f"Reversal of {r.replacement_number}",
        )
    if r.replacement_product_id and r.replacement_qty:
        inventory_service.adjust(
            session, r.replacement_product_id, r.replacement_qty,
            remarks=f"Reversal of {r.replacement_number}",
        )
    session.delete(r)
    return True


def _utc_window_for_ist_date(drawer_date: str) -> tuple[datetime, datetime]:
    y, m, d = (int(x) for x in drawer_date.split("-"))
    start_ist = datetime(y, m, d, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    return (
        start_ist.astimezone(timezone.utc).replace(tzinfo=None),
        end_ist.astimezone(timezone.utc).replace(tzinfo=None),
    )


def refunds_for_date(session: Session, drawer_date: str) -> float:
    """Total CASH refunded on an IST date — deducted from the cash drawer."""
    start, end = _utc_window_for_ist_date(drawer_date)
    rows = session.scalars(
        select(Replacement).where(
            Replacement.created_at >= start, Replacement.created_at < end
        )
    ).all()
    total = 0.0
    for r in rows:
        if ist_date_key(r.created_at) != drawer_date:
            continue
        total += float(r.refund_amount or 0)
    return round(total, 2)


def summary_for_range(session: Session, start: datetime, end: datetime) -> dict:
    """Replacement + refund totals for the reports module."""
    rows = session.scalars(
        select(Replacement).where(
            Replacement.created_at >= start, Replacement.created_at <= end
        )
    ).all()
    return {
        "count": len(rows),
        "refund_total": round(sum(float(r.refund_amount or 0) for r in rows), 2),
        "collected_total": round(sum(float(r.collected_amount or 0) for r in rows), 2),
        "items": [_serialize(r) for r in rows],
    }


def today_stats(session: Session) -> dict:
    key = datetime.now(IST).strftime("%Y-%m-%d")
    start, end = _utc_window_for_ist_date(key)
    rows = session.scalars(
        select(Replacement).where(
            Replacement.created_at >= start, Replacement.created_at < end
        )
    ).all()
    rows = [r for r in rows if ist_date_key(r.created_at) == key]
    return {
        "count": len(rows),
        "refund_total": round(sum(float(r.refund_amount or 0) for r in rows), 2),
        "collected_total": round(sum(float(r.collected_amount or 0) for r in rows), 2),
    }
