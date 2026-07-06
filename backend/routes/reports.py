"""Report endpoints (PDF downloads)."""
from __future__ import annotations

from datetime import date, datetime

from flask import Blueprint, current_app, request, send_file

from database.db import session_scope
from utils.responses import error

reports_bp = Blueprint("reports", __name__, url_prefix="/api/reports")


@reports_bp.get("/daily-pdf")
def daily_pdf():
    """Download the Daily Sales Report PDF for ?date=YYYY-MM-DD (default: today)."""
    from backend.services import report_service

    date_str = request.args.get("date")
    if date_str:
        try:
            report_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            return error("validation_error", "date must be in YYYY-MM-DD format.")
    else:
        report_date = date.today()

    try:
        with session_scope() as s:
            pdf_bytes = report_service.build_daily_report(s, report_date)
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("Daily report PDF failed")
        return error("report_error", f"{type(exc).__name__}: {exc}", status=500)

    import io

    filename = f"Daily_Report_{report_date.strftime('%Y_%m_%d')}.pdf"
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=filename,
    )
