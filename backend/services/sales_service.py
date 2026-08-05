"""History and daily-sales read models."""
from __future__ import annotations

from sqlalchemy.orm import Session

from backend.services.billing_service import serialize_bill
from database.crud import repositories as repo
from utils.validators import ValidationError


def bill_history(session: Session, limit: int = 50) -> list[dict]:
    return [serialize_bill(b, session) for b in repo.bills.recent(session, limit)]


def bill_detail(session: Session, bill_id: int) -> dict:
    bill = repo.bills.get(session, bill_id)
    if bill is None:
        raise ValidationError("Bill not found.")
    return serialize_bill(bill, session, with_items=True)


def daily_sales(session: Session, limit: int = 30) -> list[dict]:
    from backend.services import manual_sales_service

    rows = {
        s.sale_date: {
            "date": s.sale_date,
            "num_bills": s.num_bills,
            "total_sales": round(s.total_sales, 2),
            "total_discount": round(s.total_discount, 2),
            "net_sales": round(s.net_sales, 2),
            "manual_sales": 0.0,
        }
        for s in repo.daily_sales.recent(session, limit)
    }
    # Fold in manual entries: add to an existing day, or surface a manual-only day.
    for m in manual_sales_service.list_all(session, limit=400):
        d = m["date"]
        if d in rows:
            rows[d]["manual_sales"] = m["amount"]
            rows[d]["net_sales"] = round(rows[d]["net_sales"] + m["amount"], 2)
        else:
            rows[d] = {
                "date": d, "num_bills": 0, "total_sales": m["amount"],
                "total_discount": 0.0, "net_sales": m["amount"],
                "manual_sales": m["amount"],
            }
    # Newest date first.
    return sorted(rows.values(), key=lambda r: r["date"], reverse=True)[:limit]


def bill_history_filtered(session, *, date_from=None, date_to=None, query=None,
                          limit=50, offset=0):
    """All bills, newest first, with optional IST date-range + bill-number search
    and pagination. Returns {items, total, has_more}."""
    from datetime import datetime, timedelta, timezone

    from backend.services.timezone_util import IST, ist_date_key
    from database.models import Bill

    q = session.query(Bill)

    # IST date range -> UTC window.
    def _ist_to_utc(dstr, end=False):
        y, m, d = (int(x) for x in dstr.split("-"))
        base = datetime(y, m, d, tzinfo=IST)
        if end:
            base = base + timedelta(days=1)
        return base.astimezone(timezone.utc).replace(tzinfo=None)

    if date_from:
        try:
            q = q.filter(Bill.bill_date >= _ist_to_utc(date_from))
        except (ValueError, AttributeError):
            pass
    if date_to:
        try:
            q = q.filter(Bill.bill_date < _ist_to_utc(date_to, end=True))
        except (ValueError, AttributeError):
            pass
    if query and query.strip():
        like = f"%{query.strip()}%"
        q = q.filter(Bill.bill_number.ilike(like))

    total = q.count()
    rows = (q.order_by(Bill.bill_date.desc())
             .offset(max(0, offset)).limit(max(1, min(limit, 200))).all())
    items = [serialize_bill(b, session) for b in rows]
    return {
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": (offset + len(rows)) < total,
    }
