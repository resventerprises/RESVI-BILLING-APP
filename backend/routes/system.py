"""
System routes: health check and runtime information.

Exists so Phase 1 is verifiably running end to end and so the future Android
client has a stable endpoint to confirm server reachability and model identity.
"""
from __future__ import annotations

from flask import Blueprint, current_app

from config import ai_config, settings
from utils.responses import ok

system_bp = Blueprint("system", __name__, url_prefix="/api/system")


@system_bp.get("/health")
def health():
    return ok({"status": "up"})


@system_bp.get("/info")
def info():
    recognizer = current_app.config["RECOGNIZER"]
    store = current_app.config["VECTOR_STORE"]
    return ok(
        {
            "app": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "model_id": recognizer.provider.model_id,
            "embedding_dim": recognizer.provider.dim,
            "indexed_vectors": store.size(),
            "thresholds": {
                "auto_add": ai_config.AUTO_ADD_THRESHOLD,
                "confirm": ai_config.CONFIRM_THRESHOLD,
                "ambiguity_margin": ai_config.AMBIGUITY_MARGIN,
            },
        }
    )
