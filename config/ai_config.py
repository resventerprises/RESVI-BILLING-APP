"""
AI / recognition configuration.

The confidence tiers and the active model live here so the shop can be tuned
against real images by editing one file (or env vars) without touching the
recognition logic. These are starting values, decided up front:

    auto-add  : cosine similarity >= AUTO_ADD_THRESHOLD
    confirm   : CONFIRM_THRESHOLD <= similarity < AUTO_ADD_THRESHOLD
    manual    : similarity < CONFIRM_THRESHOLD

A separate, hard rule overrides confidence: if the top two candidates belong
to the same product family (e.g. the same item in two sizes), we NEVER
auto-add — we force the variant-picker popup, because a single camera frame
cannot judge absolute size. This is the #1 real-world failure mode for the
RESVI catalogue and is handled as policy, not left to the model.
"""
from __future__ import annotations

import os


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    return float(raw) if raw is not None else default


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    return int(raw) if raw is not None else default


# --- Confidence tiers (cosine similarity, range -1..1, normalized vectors) ---
# Tiered, safe recognition (per the v1 spec):
#   similarity >= AUTO_ADD_THRESHOLD  -> auto-add
#   CONFIRM..AUTO                     -> show top suggestions, user picks
#   < CONFIRM_THRESHOLD               -> "No product detected" (never auto-add)
IMMEDIATE_MODE: bool = os.environ.get("RESVI_IMMEDIATE_MODE", "false").lower() in {
    "1", "true", "yes", "on"
}
AUTO_ADD_THRESHOLD: float = _env_float("RESVI_AUTO_ADD_THRESHOLD", 0.90)
CONFIRM_THRESHOLD: float = _env_float("RESVI_CONFIRM_THRESHOLD", 0.70)

# Margin below which two top candidates are "too close to call" even if the
# top score is high — used to escalate AUTO_ADD into a CONFIRM.
AMBIGUITY_MARGIN: float = _env_float("RESVI_AMBIGUITY_MARGIN", 0.04)

# How many candidates the confirm/manual popups show.
TOP_K: int = _env_int("RESVI_TOP_K", 3)

# --- Active embedding model --------------------------------------------------
# Provider is resolved by name at startup. "dummy" keeps the whole pipeline
# runnable with zero heavy dependencies (Phase 1). Switch to "dinov2" once
# torch is installed; the rest of the system does not change.
EMBEDDING_PROVIDER: str = os.environ.get("RESVI_EMBEDDING_PROVIDER", "classic")

# Logical model id stored alongside every vector. Re-enrolling under a new
# model id is how you swap models without corrupting the existing index.
MODEL_ID: str = os.environ.get("RESVI_MODEL_ID", "classic-v1")

# --- Preprocessing -----------------------------------------------------------
# Guide-box crop is expressed as a fraction of the frame's shorter side,
# centered. The scanner UI draws the same box so the user frames the object.
GUIDE_BOX_FRACTION: float = _env_float("RESVI_GUIDE_BOX_FRACTION", 0.7)
REMOVE_BACKGROUND: bool = os.environ.get("RESVI_REMOVE_BACKGROUND", "false").lower() in {
    "1", "true", "yes", "on"
}
