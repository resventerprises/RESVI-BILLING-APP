"""Report endpoints: daily / monthly / custom-range, as PDF or Excel, plus a
JSON 'view' endpoint for on-screen display. Supports filters."""
from __future__ import annotations

import io
from datetime import date, datetime

from flask import Blueprint, current_app, request, send_file

from database.db import session_scope
from backend.services.timezone_util import ist_date_str, ist_time_str
from utils.responses import error, ok

reports_bp = Blueprint("reports", __name__, url_prefix="/api/reports")


def _filters():
    g = request.args.get
    return {
        "category_id": g("category_id", type=int),
        "product_name": g("product"),
        "bill_number": g("bill_number"),
        "min_amount": g("min_amount", type=float),
        "max_amount": g("max_amount", type=float),
    }


def _resolve_range():
    """Return (start, end, report_type, period_label, fname_stub) from query args,
    or (None, error_response) on bad input."""
    from backend.services import report_service as R

    g = request.args.get
    kind = g("type", "daily")
    if kind == "daily":
        ds = g("date")
        try:
            d = datetime.strptime(ds, "%Y-%m-%d").date() if ds else date.today()
        except ValueError:
            return None, error("validation_error", "date must be YYYY-MM-DD.")
        start, end = R.day_range(d)
        return (start, end, "Daily Sales Report", d.strftime("Date: %d-%m-%Y"),
                f"Daily_Report_{d.strftime('%Y_%m_%d')}"), None
    if kind == "monthly":
        try:
            year = int(g("year")); month = int(g("month"))
            start, end = R.month_range(year, month)
        except (TypeError, ValueError):
            return None, error("validation_error", "Provide numeric year and month.")
        label = datetime(year, month, 1).strftime("%B %Y")
        return (start, end, "Monthly Sales Report", f"Month: {label}",
                f"Monthly_Report_{datetime(year, month, 1).strftime('%B_%Y')}"), None
    if kind == "custom":
        try:
            f = datetime.strptime(g("from"), "%Y-%m-%d").date()
            t = datetime.strptime(g("to"), "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return None, error("validation_error", "Provide from and to as YYYY-MM-DD.")
        if t < f:
            return None, error("validation_error", "'to' date is before 'from' date.")
        from datetime import time as _time
        start = datetime.combine(f, _time.min); end = datetime.combine(t, _time.max)
        return (start, end, "Custom Range Report",
                f"From {f.strftime('%d-%m-%Y')} to {t.strftime('%d-%m-%Y')}",
                f"Report_{f.strftime('%Y_%m_%d')}_to_{t.strftime('%Y_%m_%d')}"), None
    return None, error("validation_error", "type must be daily, monthly, or custom.")


@reports_bp.get("/view")
def view_report():
    """JSON summary for on-screen display."""
    from backend.services import report_service as R

    resolved, err = _resolve_range()
    if err:
        return err
    start, end, rtype, label, _ = resolved
    with session_scope() as s:
        data = R._aggregate(s, start, end, **_filters())
        from backend.services import replacement_service
        reps = replacement_service.summary_for_range(s, start, end)
        return ok({
            "replacements": {"count": reps["count"], "refund_total": reps["refund_total"],
                             "collected_total": reps["collected_total"]},
            "report_type": rtype, "period": label,
            "total_bills": data["total_bills"], "total_items": data["total_items"],
            "gross": round(data["gross"], 2), "discount": round(data["discount"], 2),
            "net": round(data["net"], 2),
            "payment": {k: round(v, 2) for k, v in data["pay"].items()},
            "cash_sales": data.get("cash_sales", 0), "online_sales": data.get("online_sales", 0),
            "top_products": [{"name": n, "qty": q, "revenue": round(r, 2)}
                             for n, q, r in data["top_products"][:10]],
            "daily": [{"date": d.strftime("%d %b"), "amount": round(v, 2)} for d, v in data["daily"]],
            "bills": [{"bill_number": b.bill_number,
                       "date": ist_date_str(b.bill_date),
                       "time": ist_time_str(b.bill_date),
                       "items": b.total_items or 0, "amount": round(b.grand_total or 0, 2)}
                      for b in data["bills"]],
        })


@reports_bp.get("/pdf")
def report_pdf():
    from backend.services import report_service as R

    resolved, err = _resolve_range()
    if err:
        return err
    start, end, rtype, label, stub = resolved
    include_daily = request.args.get("type") in ("monthly", "custom")
    try:
        with session_scope() as s:
            data = R._aggregate(s, start, end, **_filters())
            # Attach cash drawer info for single-day reports.
            cash = None
            if request.args.get("type", "daily") == "daily":
                from backend.services import cash_service
                from datetime import datetime as _dt
                ds = request.args.get("date")
                dkey = ds if ds else cash_service.today_key()
                try:
                    _dt.strptime(dkey, "%Y-%m-%d")
                    from database.models import CashDrawer
                    row = s.get(CashDrawer, dkey)
                    if row:
                        cash = cash_service._serialize(s, row)
                except ValueError:
                    cash = None
            pdf = R.build_report_pdf(data, report_type=rtype, period_label=label,
                                     include_daily=include_daily, cash=cash)
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("report pdf failed")
        return error("report_error", f"{type(exc).__name__}: {exc}", status=500)
    return send_file(io.BytesIO(pdf), mimetype="application/pdf",
                     as_attachment=True, download_name=f"{stub}.pdf")


@reports_bp.get("/excel")
def report_excel():
    from backend.services import report_service as R

    resolved, err = _resolve_range()
    if err:
        return err
    start, end, rtype, label, stub = resolved
    try:
        with session_scope() as s:
            data = R._aggregate(s, start, end, **_filters())
            xlsx = R.build_report_excel(data, report_type=rtype, period_label=label)
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("report excel failed")
        return error("report_error", f"{type(exc).__name__}: {exc}", status=500)
    return send_file(io.BytesIO(xlsx),
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     as_attachment=True, download_name=f"{stub}.xlsx")


# Back-compat: the old daily-pdf endpoint still works.
@reports_bp.get("/daily-pdf")
def daily_pdf_legacy():
    from backend.services import report_service as R

    ds = request.args.get("date")
    try:
        d = datetime.strptime(ds, "%Y-%m-%d").date() if ds else date.today()
    except ValueError:
        return error("validation_error", "date must be YYYY-MM-DD.")
    start, end = R.day_range(d)
    with session_scope() as s:
        data = R._aggregate(s, start, end)
        pdf = R.build_report_pdf(data, report_type="Daily Sales Report",
                                 period_label=d.strftime("Date: %d-%m-%Y"))
    return send_file(io.BytesIO(pdf), mimetype="application/pdf", as_attachment=True,
                     download_name=f"Daily_Report_{d.strftime('%Y_%m_%d')}.pdf")
