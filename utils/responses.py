"""
Uniform JSON response envelopes.

Every API response uses the same shape so the web frontend and the future
Android client parse one contract:

    success: {"ok": true,  "data": <payload>}
    error  : {"ok": false, "error": {"code": <str>, "message": <str>}}
"""
from __future__ import annotations

from typing import Any

from flask import jsonify


def ok(data: Any = None, status: int = 200):
    return jsonify({"ok": True, "data": data}), status


def error(code: str, message: str, status: int = 400):
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status
