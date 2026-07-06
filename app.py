"""
RESVI application factory.

Boots in dependency order: runtime dirs + tables -> embedding provider (model)
+ vector store (index) -> recognizer + index rebuild from DB -> blueprints.
The recognizer and store live on app.config so one shared index serves every
request. Run with:  python app.py
"""
from __future__ import annotations

from flask import Flask, request

from ai.enrollment import rebuild_index
from ai.factory import build_provider
from ai.index.vector_store import NumpyVectorStore
from ai.recognizer import AIRecognizer
from config import settings
from database.db import init_db, session_scope


def _register_blueprints(app: Flask) -> None:
    from backend.routes.admin import admin_bp
    from backend.routes.categories import categories_bp
    from backend.routes.commerce import billing_bp, sales_bp, scan_bp
    from backend.routes.inventory import inventory_bp
    from backend.routes.products import products_bp
    from backend.routes.reports import reports_bp
    from backend.routes.settings_routes import settings_bp
    from backend.routes.system import system_bp
    from backend.routes.web import web_bp

    for bp in (
        web_bp,
        system_bp,
        categories_bp,
        products_bp,
        scan_bp,
        billing_bp,
        sales_bp,
        inventory_bp,
        settings_bp,
        admin_bp,
        reports_bp,
    ):
        app.register_blueprint(bp)


def create_app() -> Flask:
    settings.ensure_runtime_dirs()
    init_db()

    # --- Startup diagnostics: which database, and does data persist? ---------
    import logging
    from sqlalchemy import func, select
    from database.db import _db_url, _is_sqlite
    from database.models import Product

    logging.basicConfig(level=logging.INFO)
    _log = logging.getLogger("resvi.startup")
    backend = "SQLite (EPHEMERAL on Render — data is wiped on restart!)" if _is_sqlite else "PostgreSQL (persistent, shared across devices)"
    # Mask any password in the URL before logging.
    _safe_url = _db_url
    if "@" in _safe_url and "://" in _safe_url:
        _scheme, _rest = _safe_url.split("://", 1)
        if "@" in _rest:
            _creds, _host = _rest.split("@", 1)
            _user = _creds.split(":", 1)[0] if ":" in _creds else _creds
            _safe_url = f"{_scheme}://{_user}:***@{_host}"
    try:
        with session_scope() as _s:
            _count = _s.scalar(select(func.count(Product.id))) or 0
    except Exception as _e:  # noqa: BLE001
        _count = f"unknown ({_e})"
    _log.info("=" * 60)
    _log.info("RESVI %s starting", settings.APP_VERSION)
    _log.info("Database backend : %s", backend)
    _log.info("Database URL     : %s", _safe_url)
    _log.info("Products in DB   : %s", _count)
    if _is_sqlite:
        _log.info("NOTE: set RESVI_DATABASE_URL to a PostgreSQL URL for permanent, multi-device data.")
    _log.info("=" * 60)

    app = Flask(
        __name__,
        static_folder=str(settings.STATIC_DIR),
        template_folder=str(settings.TEMPLATE_DIR),
    )
    app.config["APP_NAME"] = settings.APP_NAME
    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB upload ceiling
    # Never let the browser cache CSS/JS — stale cached assets are the usual
    # cause of an "unstyled page" after an update.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.context_processor
    def inject_asset_version():
        # Appended to asset URLs so a new build always busts the cache.
        return {"asset_version": settings.APP_VERSION}

    @app.after_request
    def no_store_static(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    provider = build_provider()
    store = NumpyVectorStore()
    recognizer = AIRecognizer(provider=provider, store=store)

    with session_scope() as session:
        loaded = rebuild_index(session, provider, store)
        if loaded == 0:
            # Index is empty for the active model. If there are already saved
            # products (e.g. enrolled under a previous recognizer), re-embed
            # them from their saved photos so scanning works immediately.
            from sqlalchemy import func, select as _select
            from database.models import Product

            n_products = session.scalar(_select(func.count(Product.id))) or 0
            if n_products > 0:
                from ai.enrollment import reindex_all

                result = reindex_all(session, recognizer)
                loaded = result["embedded"]
                app.logger.info(
                    "Auto re-embedded %d images for %d products under %s (skipped %d).",
                    result["embedded"], result["products"], provider.model_id, result["skipped"],
                )
    app.logger.info("Index ready: %d vectors (model=%s)", loaded, provider.model_id)

    app.config["RECOGNIZER"] = recognizer
    app.config["VECTOR_STORE"] = store

    _register_blueprints(app)
    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=settings.DEBUG)
