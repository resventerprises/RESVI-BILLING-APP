"""Daily sales report as a downloadable PDF (reportlab).

Aggregates all bills for a given calendar date into: summary totals, a
per-bill table, top-selling products, and a payment-method breakdown.
"""
from __future__ import annotations

import io
from collections import defaultdict
from datetime import date, datetime, time

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from database.crud import repositories as repo
from database.models import Bill, BillItem, Product

BRAND = colors.HexColor("#0f766e")
LIGHT = colors.HexColor("#e6f2f0")


def _rupees(v: float) -> str:
    return f"Rs.{(v or 0):,.2f}"


def build_daily_report(session: Session, report_date: date) -> bytes:
    start = datetime.combine(report_date, time.min)
    end = datetime.combine(report_date, time.max)

    bills = (
        session.query(Bill)
        .filter(Bill.bill_date >= start, Bill.bill_date <= end)
        .order_by(Bill.bill_date.asc())
        .all()
    )

    total_bills = len(bills)
    total_items = sum(b.total_items or 0 for b in bills)
    gross = sum(b.subtotal or 0 for b in bills)
    discount = sum(b.total_discount or 0 for b in bills)
    net = sum(b.grand_total or 0 for b in bills)

    # Payment breakdown.
    pay = defaultdict(float)
    for b in bills:
        pay[(b.payment_method or "cash").lower()] += b.grand_total or 0

    # Top-selling products for the day.
    bill_ids = [b.id for b in bills]
    top: list[tuple[str, int]] = []
    if bill_ids:
        rows = (
            session.query(BillItem.product_id, BillItem.item_name,
                          func.sum(BillItem.quantity).label("qty"))
            .filter(BillItem.bill_id.in_(bill_ids))
            .group_by(BillItem.product_id, BillItem.item_name)
            .order_by(func.sum(BillItem.quantity).desc())
            .limit(10)
            .all()
        )
        for pid, iname, qty in rows:
            if pid is not None:
                p = repo.products.get(session, pid)
                name = p.product_name if p else "(deleted product)"
            else:
                name = iname or "(manual item)"
            top.append((name, int(qty or 0)))

    # ---- Build the PDF ----
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=16 * mm, bottomMargin=16 * mm,
        leftMargin=16 * mm, rightMargin=16 * mm,
        title=f"Daily Sales Report {report_date.isoformat()}",
    )
    styles = getSampleStyleSheet()
    h_brand = ParagraphStyle("brand", parent=styles["Title"], textColor=BRAND, fontSize=20, spaceAfter=2)
    h_sub = ParagraphStyle("sub", parent=styles["Normal"], fontSize=12, textColor=colors.HexColor("#444"), spaceAfter=1)
    h_sec = ParagraphStyle("sec", parent=styles["Heading2"], fontSize=13, textColor=BRAND, spaceBefore=12, spaceAfter=6)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#666"))

    story = []
    story.append(Paragraph("RESVI ENTERPRISES", h_brand))
    story.append(Paragraph("Daily Sales Report", h_sub))
    story.append(Paragraph(
        f"Date: {report_date.strftime('%d-%m-%Y')} &nbsp;&nbsp;|&nbsp;&nbsp; "
        f"Generated: {datetime.now().strftime('%d-%m-%Y %I:%M %p')}", small))
    story.append(Spacer(1, 8))

    # Summary block
    story.append(Paragraph("Summary", h_sec))
    summary_data = [
        ["Total Bills", str(total_bills)],
        ["Total Items Sold", str(total_items)],
        ["Gross Sales", _rupees(gross)],
        ["Total Discount", _rupees(discount)],
        ["Net Sales", _rupees(net)],
    ]
    st = Table(summary_data, colWidths=[70 * mm, 100 * mm])
    st.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), LIGHT),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
        ("FONTNAME", (0, 4), (-1, 4), "Helvetica-Bold"),
        ("TEXTCOLOR", (1, 4), (1, 4), BRAND),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d0d8d6")),
    ]))
    story.append(st)

    # Bill details table
    story.append(Paragraph("Bill Details", h_sec))
    if bills:
        rows = [["Bill Number", "Time", "Items", "Bill Amount"]]
        for b in bills:
            rows.append([
                b.bill_number,
                b.bill_date.strftime("%I:%M %p") if b.bill_date else "-",
                str(b.total_items or 0),
                _rupees(b.grand_total),
            ])
        bt = Table(rows, colWidths=[50 * mm, 40 * mm, 30 * mm, 50 * mm], repeatRows=1)
        bt.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), BRAND),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d0d8d6")),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(bt)
    else:
        story.append(Paragraph("No bills recorded for this date.", small))

    # Top selling products
    story.append(Paragraph("Top Selling Products", h_sec))
    if top:
        rows = [["Product Name", "Quantity Sold"]]
        rows += [[name, str(qty)] for name, qty in top]
        tp = Table(rows, colWidths=[120 * mm, 50 * mm], repeatRows=1)
        tp.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), BRAND),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d0d8d6")),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(tp)
    else:
        story.append(Paragraph("No products sold on this date.", small))

    # Payment summary
    story.append(Paragraph("Payment Summary", h_sec))
    pay_rows = [["Method", "Amount"]]
    for method in ("cash", "upi", "card"):
        pay_rows.append([method.upper(), _rupees(pay.get(method, 0))])
    pt = Table(pay_rows, colWidths=[70 * mm, 100 * mm])
    pt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d0d8d6")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(pt)

    story.append(Spacer(1, 18))
    story.append(Paragraph("Generated by RESVI Billing App.", small))

    doc.build(story)
    buf.seek(0)
    return buf.getvalue()
