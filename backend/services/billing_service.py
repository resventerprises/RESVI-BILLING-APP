"""
Billing service.

The cart lives on the client (single counter, no login) for instant quantity
merges and undo. On Complete Bill the client posts the line items; the server
is authoritative: it recomputes every total from the current product record
(never trusting client-sent prices), persists the bill with a generated
number, and rolls the totals into the daily summary.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from backend.services.code_generator import next_bill_number
from database.crud import repositories as repo
from database.models import Bill, BillItem, DailySale
from utils.validators import ValidationError


def _line_total(unit_price: float, discount: float, quantity: int) -> float:
    return round((unit_price - discount) * quantity, 2)


def complete_bill(session: Session, cart_items: list[dict], payment_method: str = "cash",
                  final_amount: float | None = None,
                  manual_items: list[dict] | None = None) -> Bill:
    """cart_items: [{"product_id": int, "quantity": int}, ...]

    manual_items: [{"name": str, "price": float, "quantity": int}, ...] — one-off
    items that exist only on this bill (not saved to products/inventory).

    final_amount: optional manual override (bargain). When given, the bill's
    grand total becomes this amount and the difference from subtotal is recorded
    as discount. Product prices are never changed.
    """
    if not cart_items and not manual_items:
        raise ValidationError("Cannot complete an empty bill.")
    payment_method = (payment_method or "cash").lower()
    if payment_method not in {"cash", "upi", "card"}:
        payment_method = "cash"

    # Merge duplicate product rows defensively (Bottle x3, not three rows).
    merged: dict[int, int] = {}
    for item in cart_items:
        pid = int(item["product_id"])
        qty = int(item.get("quantity", 1))
        if qty <= 0:
            continue
        merged[pid] = merged.get(pid, 0) + qty
    if not merged and not manual_items:
        raise ValidationError("Cannot complete an empty bill.")

    bill = repo.bills.create(
        session,
        bill_number=next_bill_number(session),
        bill_date=datetime.now(timezone.utc),
        total_items=0,
        subtotal=0.0,
        total_discount=0.0,
        grand_total=0.0,
        payment_method=payment_method,
    )

    subtotal = 0.0
    total_discount = 0.0
    total_items = 0
    for product_id, quantity in merged.items():
        product = repo.products.get(session, product_id)
        if product is None:
            raise ValidationError(f"Product {product_id} no longer exists.")
        unit = product.selling_price
        disc = product.discount
        line = _line_total(unit, disc, quantity)
        repo.bills  # noqa  (keep import usage explicit)
        session.add(
            BillItem(
                bill_id=bill.id,
                product_id=product_id,
                quantity=quantity,
                unit_price=unit,
                discount=disc,
                total_price=line,
            )
        )
        subtotal += unit * quantity
        total_discount += disc * quantity
        total_items += quantity

    # Manual one-off items: billed but never saved to products/inventory.
    for m in (manual_items or []):
        name = str(m.get("name", "")).strip()
        if not name:
            raise ValidationError("Manual item name is required.")
        try:
            price = round(float(m.get("price", 0)), 2)
            qty = int(m.get("quantity", 1))
        except (TypeError, ValueError):
            raise ValidationError("Manual item price/quantity must be numbers.")
        if price < 0:
            raise ValidationError("Manual item price cannot be negative.")
        if qty <= 0:
            continue
        line = round(price * qty, 2)
        session.add(
            BillItem(
                bill_id=bill.id,
                product_id=None,
                item_name=name,
                quantity=qty,
                unit_price=price,
                discount=0.0,
                total_price=line,
            )
        )
        subtotal += price * qty
        total_items += qty

    grand_total = round(subtotal - total_discount, 2)

    # Manual final-amount (bargain): override grand total, book the rest as discount.
    if final_amount is not None:
        try:
            final_amount = round(float(final_amount), 2)
        except (TypeError, ValueError):
            raise ValidationError("Final amount must be a number.")
        if final_amount < 0:
            raise ValidationError("Final amount cannot be negative.")
        if final_amount > round(subtotal, 2):
            raise ValidationError("Final amount cannot exceed the subtotal.")
        total_discount = round(subtotal - final_amount, 2)
        grand_total = final_amount

    repo.bills.update(
        session,
        bill,
        total_items=total_items,
        subtotal=round(subtotal, 2),
        total_discount=round(total_discount, 2),
        grand_total=grand_total,
    )

    _roll_daily(session, bill)
    # Deduct sold quantities from inventory.
    from backend.services import inventory_service
    for product_id, quantity in merged.items():
        inventory_service.record_sale_out(session, product_id, quantity, bill.bill_number)
    return bill


def _roll_daily(session: Session, bill: Bill) -> None:
    key = bill.bill_date.astimezone(timezone.utc).strftime("%Y-%m-%d")
    summary = repo.daily_sales.get(session, key)
    if summary is None:
        summary = DailySale(sale_date=key)
        session.add(summary)
        session.flush()
    summary.num_bills += 1
    summary.total_sales += bill.subtotal
    summary.total_discount += bill.total_discount
    summary.net_sales += bill.grand_total


def serialize_bill(bill: Bill, session: Session, with_items: bool = False) -> dict:
    data = {
        "id": bill.id,
        "bill_number": bill.bill_number,
        "bill_date": bill.bill_date.isoformat(),
        "total_items": bill.total_items,
        "subtotal": bill.subtotal,
        "total_discount": bill.total_discount,
        "grand_total": bill.grand_total,
        "payment_method": getattr(bill, "payment_method", "cash"),
    }
    if with_items:
        data["items"] = [
            {
                "product_id": it.product_id,
                "product_name": (
                    it.item_name if it.product_id is None
                    else (p.product_name if (p := repo.products.get(session, it.product_id)) else "\u2014")
                ),
                "manual": it.product_id is None,
                "quantity": it.quantity,
                "unit_price": it.unit_price,
                "discount": it.discount,
                "total_price": it.total_price,
            }
            for it in bill.items
        ]
    return data
