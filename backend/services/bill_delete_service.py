"""Deleting bills — restores stock and cascades bill items.

Reports/daily/monthly/top-products are all computed live from the bills table,
so once a bill is gone every report reflects it automatically (no recalc step).
"""
from __future__ import annotations

from datetime import date, datetime, time

from sqlalchemy.orm import Session

from backend.services import inventory_service
from database.models import Bill, BillItem


def _restore_stock_and_delete(session: Session, bill: Bill) -> None:
    """Add sold quantities back to stock, reverse the daily aggregate, then
    delete the bill (items cascade)."""
    from backend.services import billing_service

    for it in list(bill.items):
        if it.product_id is not None and it.quantity:
            # Put the sold units back; adjust() records a StockMovement.
            inventory_service.adjust(
                session, it.product_id, it.quantity,
                remarks=f"Reversal: deleted bill {bill.bill_number}",
            )
    billing_service.unroll_daily(session, bill)  # keep DailySale aggregate correct
    session.delete(bill)  # BillItem has ondelete=CASCADE


def delete_bill(session: Session, bill_id: int) -> bool:
    bill = session.get(Bill, bill_id)
    if not bill:
        return False
    _restore_stock_and_delete(session, bill)
    return True


def delete_by_date(session: Session, d: date) -> int:
    start = datetime.combine(d, time.min)
    end = datetime.combine(d, time.max)
    bills = session.query(Bill).filter(Bill.bill_date >= start, Bill.bill_date <= end).all()
    for b in bills:
        _restore_stock_and_delete(session, b)
    return len(bills)


def delete_by_range(session: Session, d_from: date, d_to: date) -> int:
    start = datetime.combine(d_from, time.min)
    end = datetime.combine(d_to, time.max)
    bills = session.query(Bill).filter(Bill.bill_date >= start, Bill.bill_date <= end).all()
    for b in bills:
        _restore_stock_and_delete(session, b)
    return len(bills)


def clear_today(session: Session) -> int:
    return delete_by_date(session, date.today())


def clear_all(session: Session) -> int:
    bills = session.query(Bill).all()
    for b in bills:
        _restore_stock_and_delete(session, b)
    return len(bills)
