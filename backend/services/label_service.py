"""
Barcode label generation.

Produces printable Code128 labels as a PDF — either a single label or an A4
sticker sheet with many copies — using reportlab's built-in Code128 (no extra
dependency). Each label shows the product name, price, the Code128 barcode
image, and the human-readable barcode number.
"""
from __future__ import annotations

import io

from reportlab.graphics.barcode import code128
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


def _draw_label(c: canvas.Canvas, x: float, y: float, w: float, h: float,
                name: str, price: str, barcode: str) -> None:
    """Draw one label with its lower-left corner at (x, y)."""
    pad = 3 * mm
    # Product name (top), truncated to fit.
    c.setFont("Helvetica-Bold", 8)
    label_name = name if len(name) <= 28 else name[:27] + "\u2026"
    c.drawString(x + pad, y + h - pad - 6, label_name)
    # Price (top-right).
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(x + w - pad, y + h - pad - 6, price)

    # Barcode image, centred.
    bc = code128.Code128(barcode, barHeight=h * 0.42, barWidth=0.42 * mm, humanReadable=False)
    bc_w = bc.width
    bx = x + (w - bc_w) / 2
    if bx < x + pad:
        # Too wide: shrink bar width to fit.
        scale = (w - 2 * pad) / bc_w
        bc = code128.Code128(barcode, barHeight=h * 0.42, barWidth=0.42 * mm * scale, humanReadable=False)
        bc_w = bc.width
        bx = x + (w - bc_w) / 2
    bc.drawOn(c, bx, y + pad + 8)

    # Human-readable number (bottom, centred).
    c.setFont("Helvetica", 8)
    c.drawCentredString(x + w / 2, y + pad, barcode)


def single_label_pdf(name: str, price: str, barcode: str,
                     width_mm: float = 50, height_mm: float = 30) -> bytes:
    """One label sized to a typical thermal sticker (default 50x30mm)."""
    w, h = width_mm * mm, height_mm * mm
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    _draw_label(c, 0, 0, w, h, name, price, barcode)
    c.showPage()
    c.save()
    return buf.getvalue()


def sheet_pdf(labels: list[dict], cols: int = 3, rows: int = 8) -> bytes:
    """A4 sticker sheet. `labels` is a list of {name, price, barcode}, repeated
    in reading order across the grid; extra cells are left blank."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    page_w, page_h = A4
    margin = 8 * mm
    gap = 3 * mm
    cell_w = (page_w - 2 * margin - (cols - 1) * gap) / cols
    cell_h = (page_h - 2 * margin - (rows - 1) * gap) / rows

    per_page = cols * rows
    i = 0
    while i < len(labels):
        for r in range(rows):
            for col in range(cols):
                idx = i + r * cols + col
                if idx >= len(labels):
                    break
                lab = labels[idx]
                x = margin + col * (cell_w + gap)
                y = page_h - margin - (r + 1) * cell_h - r * gap
                _draw_label(c, x, y, cell_w, cell_h,
                            lab.get("name", ""), lab.get("price", ""), lab.get("barcode", ""))
        c.showPage()
        i += per_page
    c.save()
    return buf.getvalue()
