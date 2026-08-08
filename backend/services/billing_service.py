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
                  manual_items: list[dict] | None = None,
                  payment_split: dict | None = None,
                  discount_type: str | None = None,
                  discount_value: float | None = None,
                  customer_name: str | None = None,
                  customer_mobile: str | None = None) -> Bill:
    """cart_items: [{"product_id": int, "quantity": int}, ...]

    manual_items: [{"name": str, "price": float, "quantity": int}, ...] — one-off
    items that exist only on this bill (not saved to products/inventory).

    final_amount: optional manual override (bargain). When given, the bill's
    grand total becomes this amount and the difference from subtotal is recorded
    as discount. Product prices are never changed.

    payment_split: {"cash": n, "upi": n, "card": n} — when given, method is SPLIT
    and the parts must sum to the grand total.
    """
    if not cart_items and not manual_items:
        raise ValidationError("Cannot complete an empty bill.")
    payment_method = (payment_method or "cash").lower()
    if payment_method not in {"cash", "upi", "card", "split"}:
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

    # Dynamic discount: percentage or fixed amount applied to the subtotal.
    disc_type_stored = None
    disc_value_stored = 0.0
    if discount_type and discount_value is not None:
        try:
            dv = round(float(discount_value), 2)
        except (TypeError, ValueError):
            raise ValidationError("Discount value must be a number.")
        if dv < 0:
            raise ValidationError("Discount cannot be negative.")
        dtype = str(discount_type).lower()
        if dtype in ("percent", "percentage", "%"):
            if dv > 100:
                raise ValidationError("Percentage discount cannot exceed 100%.")
            disc_amount = round(subtotal * dv / 100, 2)
            disc_type_stored = "percent"
        else:
            disc_amount = dv
            disc_type_stored = "fixed"
        if disc_amount > round(subtotal, 2):
            raise ValidationError("Discount cannot exceed bill amount.")
        disc_value_stored = dv
        total_discount = round(total_discount + disc_amount, 2)
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

    # Split payment: validate the parts sum to the grand total, store breakdown.
    breakdown_json = None
    if payment_method == "split" or payment_split:
        import json as _json
        split = payment_split or {}
        try:
            parts = {k: round(float(split.get(k, 0) or 0), 2) for k in ("cash", "upi", "card")}
        except (TypeError, ValueError):
            raise ValidationError("Split amounts must be numbers.")
        if any(v < 0 for v in parts.values()):
            raise ValidationError("Split amounts cannot be negative.")
        paid = round(sum(parts.values()), 2)
        if paid != round(grand_total, 2):
            raise ValidationError(
                f"Payment total does not match bill amount. "
                f"Entered Rs.{paid:.2f}, bill is Rs.{grand_total:.2f}."
            )
        payment_method = "split"
        breakdown_json = _json.dumps(parts)

    # Optional customer capture (never mandatory). Normalise blanks to None.
    cust_name = (customer_name or "").strip() or None
    cust_mobile = (customer_mobile or "").strip() or None

    repo.bills.update(
        session,
        bill,
        total_items=total_items,
        subtotal=round(subtotal, 2),
        total_discount=round(total_discount, 2),
        discount_type=disc_type_stored,
        discount_value=disc_value_stored,
        grand_total=grand_total,
        payment_method=payment_method,
        payment_breakdown=breakdown_json,
        customer_name=cust_name,
        customer_mobile=cust_mobile,
    )

    # Maintain the customer directory (dedup by mobile). Purely for lookup —
    # never blocks billing, and failures here don't affect the bill.
    if cust_name or cust_mobile:
        try:
            from backend.services import customer_service
            customer_service.record_bill(session, cust_name, cust_mobile, grand_total)
        except Exception:
            pass

    _roll_daily(session, bill)
    # Deduct sold quantities from inventory.
    from backend.services import inventory_service
    for product_id, quantity in merged.items():
        inventory_service.record_sale_out(session, product_id, quantity, bill.bill_number)
    return bill


def _roll_daily(session: Session, bill: Bill) -> None:
    from backend.services.timezone_util import ist_date_key
    key = ist_date_key(bill.bill_date)
    summary = repo.daily_sales.get(session, key)
    if summary is None:
        summary = DailySale(sale_date=key)
        session.add(summary)
        session.flush()
    summary.num_bills += 1
    summary.total_sales += bill.subtotal
    summary.total_discount += bill.total_discount
    summary.net_sales += bill.grand_total


def unroll_daily(session: Session, bill: Bill) -> None:
    """Reverse a bill's contribution to the DailySale aggregate (on deletion).
    Removes the daily row entirely once it reaches zero bills."""
    from backend.services.timezone_util import ist_date_key
    key = ist_date_key(bill.bill_date)
    summary = repo.daily_sales.get(session, key)
    if summary is None:
        return
    summary.num_bills = max(0, (summary.num_bills or 0) - 1)
    summary.total_sales = round((summary.total_sales or 0) - (bill.subtotal or 0), 2)
    summary.total_discount = round((summary.total_discount or 0) - (bill.total_discount or 0), 2)
    summary.net_sales = round((summary.net_sales or 0) - (bill.grand_total or 0), 2)
    if summary.num_bills <= 0:
        session.delete(summary)


def serialize_bill(bill: Bill, session: Session, with_items: bool = False) -> dict:
    import json as _json

    from backend.services.timezone_util import ist_date_str, ist_time_str
    breakdown = None
    if getattr(bill, "payment_breakdown", None):
        try:
            breakdown = _json.loads(bill.payment_breakdown)
        except (ValueError, TypeError):
            breakdown = None
    data = {
        "id": bill.id,
        "bill_number": bill.bill_number,
        "bill_date": bill.bill_date.isoformat(),
        "date_ist": ist_date_str(bill.bill_date),
        "time_ist": ist_time_str(bill.bill_date),
        "total_items": bill.total_items,
        "subtotal": bill.subtotal,
        "total_discount": bill.total_discount,
        "grand_total": bill.grand_total,
        "payment_method": getattr(bill, "payment_method", "cash"),
        "payment_breakdown": breakdown,
        "customer_name": getattr(bill, "customer_name", None) or "",
        "customer_mobile": getattr(bill, "customer_mobile", None) or "",
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


def update_payment_method(session: Session, bill_id: int, new_method: str,
                          payment_split: dict | None = None) -> dict:
    """Correct the payment method on a completed bill.

    ONLY the payment method (and split amounts) change. Bill number, items,
    quantities, prices, discounts, totals and inventory are all left untouched.
    Because cash-drawer, dashboard and reports all read payment_method live from
    the bill, this correction propagates everywhere automatically. Every change
    is written to the BillPaymentEdit audit log.
    """
    import json as _json

    from database.models import Bill, BillPaymentEdit

    method = (new_method or "").strip().lower()
    if method not in ("cash", "upi", "card", "split"):
        raise ValidationError("Payment method must be cash, UPI, card or split.")

    bill = session.get(Bill, bill_id)
    if not bill:
        raise ValidationError("Bill not found.")

    old_method = bill.payment_method
    old_breakdown = bill.payment_breakdown

    new_breakdown = None
    if method == "split":
        parts = payment_split or {}
        try:
            cash = round(float(parts.get("cash", 0) or 0), 2)
            upi = round(float(parts.get("upi", 0) or 0), 2)
            card = round(float(parts.get("card", 0) or 0), 2)
        except (TypeError, ValueError):
            raise ValidationError("Split amounts must be numbers.")
        if min(cash, upi, card) < 0:
            raise ValidationError("Split amounts cannot be negative.")
        total = round(cash + upi + card, 2)
        if total != round(bill.grand_total or 0, 2):
            raise ValidationError(
                f"Split total {total} must equal the bill total {round(bill.grand_total or 0, 2)}."
            )
        new_breakdown = _json.dumps({"cash": cash, "upi": upi, "card": card})

    # Apply the correction.
    bill.payment_method = method
    bill.payment_breakdown = new_breakdown   # cleared for non-split methods

    # Audit log.
    session.add(BillPaymentEdit(
        bill_id=bill.id,
        bill_number=bill.bill_number,
        old_method=old_method,
        new_method=method,
        old_breakdown=old_breakdown,
        new_breakdown=new_breakdown,
    ))
    session.flush()
    return serialize_bill(bill, session, with_items=True)


def payment_edit_history(session: Session, bill_id: int) -> list[dict]:
    import json as _json

    from database.models import BillPaymentEdit
    from backend.services.timezone_util import ist_date_str, ist_time_str

    rows = (
        session.query(BillPaymentEdit)
        .filter(BillPaymentEdit.bill_id == bill_id)
        .order_by(BillPaymentEdit.created_at.desc())
        .all()
    )
    out = []
    for r in rows:
        out.append({
            "old_method": r.old_method,
            "new_method": r.new_method,
            "date": ist_date_str(r.created_at),
            "time": ist_time_str(r.created_at),
        })
    return out
