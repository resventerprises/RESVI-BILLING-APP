# RESVI — AI Product Recognition Billing System

A working, single-shop billing web app: point the camera at a product, the app
recognizes it and adds it to the bill. No barcode, no login. Built API-first so
the same backend logic moves to the Android build later.

Runs today on a lightweight recognizer (no heavy downloads). Real recognition
turns on by installing the ML extras and flipping one environment variable.

---

## The decision that shaped recognition

"Add a product → instantly recognizable → no Train button → scales to thousands"
rules out a classifier (YOLO head / TFLite classifier), because adding a product
to a classifier means adding a class, which means retraining. So recognition is
**embedding + vector similarity search**:

- Add Product → each image is embedded by a frozen model → the vector is stored.
  No training. (`ai/enrollment.py`)
- Scan → crop the guide box → embed → cosine nearest-neighbor → closest product
  wins. (`ai/recognizer.py`)

Enrolling = appending vectors to an index, so a product is recognizable on the
next scan. The model is swappable behind `EmbeddingProvider`: DINOv2 server-side
for the web prototype, MobileCLIP on-device for the Android build.

## Confidence policy (in `config/ai_config.py`)

| Tier     | Rule                       | Behaviour                              |
|----------|----------------------------|----------------------------------------|
| Auto-add | similarity ≥ 0.88          | add to bill, vibrate + green tick       |
| Confirm  | 0.70 ≤ similarity < 0.88   | suggestion + similar products, pick one |
| Manual   | similarity < 0.70          | top-5 + live search + add new           |

Hard overrides enforced in code, not left to the model:
- Top two matches share a **family** (same item, different size) → always Confirm
  with a variant flag. A single frame cannot judge absolute size — the #1
  real-world failure mode for this catalogue.
- Top match's lead over the runner-up thinner than the ambiguity margin →
  downgrade Auto-add to Confirm.

---

## Run it

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python scripts/smoke_test.py      # recognition pipeline + variant rule
python scripts/api_test.py        # full backend flow (category→product→scan→bill)
python app.py                     # http://localhost:5000
```

Camera scanning needs HTTPS or localhost (browser rule) and a back camera.

### Turn on real recognition
```bash
pip install -r requirements-ml.txt
export RESVI_EMBEDDING_PROVIDER=dinov2     # PowerShell: $env:RESVI_EMBEDDING_PROVIDER="dinov2"
python app.py
```
The default `dummy` provider validates wiring, thresholds, and the variant rule
end to end — it is NOT a real recognizer. Accuracy on your look-alike,
unbranded stock only shows up with DINOv2 + real shop photos, and that is where
the limits flagged in `docs/data_collection_sop.md` will surface. Image quality
is the lever, not the code.

---

## Screens (single-page app, camera stays alive across navigation)

Splash → Home (logo + large tiles) → Scan (live camera, guide box, running-bill
bar, undo, complete) → Products (cards, search, category filter, add/edit/
delete/enable-disable) → Add/Edit product (5-image enrollment) → Categories →
Bill history → Bill detail → Daily sales → Settings (version, DB backup/export,
restore).

## API

```
GET  /api/system/health|info
GET/POST            /api/categories          PUT/DELETE /api/categories/<id>
GET/POST            /api/products            PUT/DELETE /api/products/<id>
GET                 /api/products/image/<id>
POST                /api/scan                (multipart 'frame')
POST                /api/bills/complete      GET /api/bills  GET /api/bills/<id>
GET                 /api/sales/daily
GET                 /api/settings/info|backup   POST /api/settings/restore
```

All responses share one envelope: `{"ok": true, "data": ...}` or
`{"ok": false, "error": {"code", "message"}}`.

## Layout

```
config/    settings + AI thresholds          ai/        recognizer, providers, vector store, enrollment
database/  models, session, repositories     backend/   routes (thin) + services (business logic)
templates/ SPA shell                         static/    css, js (api client + app), logo
utils/     responses, validators, images     scripts/   smoke_test.py, api_test.py
```

## Notes / what's deliberately deferred

- **Logo** is a placeholder wordmark (`static/img/logo.svg`) — drop in the real
  RESVI asset.
- The cart lives client-side (single counter, no login); the server is
  authoritative at Complete Bill, recomputing every total from current product
  records rather than trusting client prices.
- SQLite is the source of truth; the vector index is derived and rebuilt from
  `product_embeddings` at startup. Swap to FAISS/pgvector behind `VectorStore`,
  or Postgres via the DB URL, with no logic changes.
- Future features the architecture already allows but v1 omits: inventory,
  suppliers, thermal printing, invoice PDF, cloud sync, auth, analytics.
- **Android (final target):** the fat-offline client implements `EmbeddingProvider`
  (MobileCLIP/TFLite) + a local `VectorStore`, reuses this REST contract for
  sync, and lifts the services unchanged.
"# RESVI-BILLING-APP" 
