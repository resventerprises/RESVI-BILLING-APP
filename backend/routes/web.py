"""Serves the single-page app shell. The SPA keeps cart state and the camera
alive across screens (the scanner must not restart between products)."""
from __future__ import annotations

from flask import Blueprint, render_template

web_bp = Blueprint("web", __name__)


@web_bp.get("/")
def index():
    return render_template("index.html")
