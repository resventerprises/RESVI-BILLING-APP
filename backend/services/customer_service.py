"""Lightweight customer directory.

Populated opportunistically when a bill captures customer details. Deduped by
mobile number. Never required for billing — this is a convenience directory for
lookup and future customer features.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.services.timezone_util import ist_date_str
from database.models import Customer


def _serialize(c: Customer) -> dict:
    return {
        "id": c.id,
        "name": c.name or "",
        "mobile": c.mobile or "",
        "total_bills": c.total_bills or 0,
        "total_spent": round(c.total_spent or 0, 2),
        "first_seen": ist_date_str(c.first_seen) if c.first_seen else "",
        "last_seen": ist_date_str(c.last_seen) if c.last_seen else "",
    }


def record_bill(session: Session, name: str | None, mobile: str | None, amount: float) -> None:
    """Create or update a customer from a completed bill. Deduped by mobile.

    If a mobile is given and already exists, that record is reused (and its name
    filled in if it was blank). With no mobile, we match by exact name to avoid
    creating a new row for every unnamed walk-in.
    """
    name = (name or "").strip() or None
    mobile = (mobile or "").strip() or None
    if not name and not mobile:
        return

    cust = None
    if mobile:
        cust = session.scalar(select(Customer).where(Customer.mobile == mobile))
    if cust is None and not mobile and name:
        cust = session.scalar(select(Customer).where(Customer.mobile.is_(None), Customer.name == name))

    if cust is None:
        cust = Customer(name=name, mobile=mobile, total_bills=0, total_spent=0.0)
        session.add(cust)
    else:
        # Fill in a missing name if this bill provides one.
        if name and not cust.name:
            cust.name = name
    cust.total_bills = (cust.total_bills or 0) + 1
    cust.total_spent = round((cust.total_spent or 0) + (amount or 0), 2)
    session.flush()


def search(session: Session, term: str | None = None, limit: int = 50) -> list[dict]:
    stmt = select(Customer)
    if term and term.strip():
        like = f"%{term.strip()}%"
        stmt = stmt.where((Customer.name.ilike(like)) | (Customer.mobile.ilike(like)))
    stmt = stmt.order_by(Customer.last_seen.desc()).limit(limit)
    return [_serialize(c) for c in session.scalars(stmt).all()]


def lookup_by_mobile(session: Session, mobile: str) -> dict | None:
    if not mobile:
        return None
    c = session.scalar(select(Customer).where(Customer.mobile == mobile.strip()))
    return _serialize(c) if c else None
