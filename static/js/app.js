/* RESVI single-page controller.
   Hash router + in-memory cart + a continuous camera scan loop. The cart lives
   here (single counter, no login) so quantity merges and undo are instant; the
   server is authoritative only at Complete Bill. */
(function () {
  "use strict";

  const view = document.getElementById("view");
  const money = (n) => "\u20B9" + Number(n || 0).toFixed(2);
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const vibrate = (ms) => navigator.vibrate && navigator.vibrate(ms);

  // ---- Single source of truth for app modules -------------------------------
  // Home tiles (mobile/tablet/desktop) are generated from this list, so adding a
  // module here makes it appear everywhere automatically. Order matches the spec.
  const MODULES = [
    { target: "scan", label: "Scan barcode", icon: "\uD83D\uDCF3", desc: "Scan or type a barcode to bill" },
    { target: "drafts", label: "Draft bills", icon: "\uD83D\uDCCB", desc: "Held bills waiting to be paid" },
    { target: "scan?voice=1", label: "Voice search", icon: "\uD83C\uDF99\uFE0F", desc: "Speak a product name to add it" },
    { target: "products", label: "Products", icon: "\uD83D\uDCE6", desc: "Browse and manage your catalogue" },
    { target: "inventory", label: "Inventory", icon: "\uD83D\uDCCA", desc: "Stock levels, stock-in and history" },
    { target: "categories", label: "Categories", icon: "\uD83D\uDDC2\uFE0F", desc: "Organize products into groups" },
    { target: "history", label: "Bill history", icon: "\uD83E\uDDFE", desc: "Review past bills" },
    { target: "replacement", label: "Replacement", icon: "\uD83D\uDD01", desc: "Returns, exchanges and refunds" },
    { target: "daily", label: "Daily sales", icon: "\uD83D\uDCC8", desc: "Day-by-day sales summary" },
    { target: "cash", label: "Cash Drawer", icon: "\uD83D\uDCB0", desc: "Opening, closing and expenses" },
    { target: "reports", label: "Reports", icon: "\uD83D\uDCC4", desc: "Daily, monthly and custom reports" },
    { target: "settings", label: "Settings", icon: "\u2699\uFE0F", desc: "Backup, restore and app info" },
  ];

  // ---- Scan sounds (Web Audio, no asset files) ------------------------------
  const Sound = (() => {
    let ctx = null;
    function ensure() {
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
      } catch (_) {}
      return ctx;
    }
    function play(notes, { type = "sine", cutoff = 5000, vol = 0.5 } = {}) {
      const c = ensure();
      if (!c) return;
      const now = c.currentTime;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoff;
      lp.connect(c.destination);
      notes.forEach(([f, start, dur]) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f, now + start);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, now + start);
        g.gain.exponentialRampToValueAtTime(vol, now + start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        o.connect(g);
        g.connect(lp);
        o.start(now + start);
        o.stop(now + start + dur + 0.03);
      });
    }
    // Crisp rising two-tone beep = success/confirmed.
    const success = () => play([[988, 0, 0.08], [1319, 0.07, 0.13]], { type: "sine", cutoff: 6000, vol: 0.55 });
    // Low descending buzz = failure / not confirmed.
    const error = () => play([[330, 0, 0.16], [196, 0.15, 0.26]], { type: "square", cutoff: 900, vol: 0.4 });
    // Two short mid taps = warning / needs confirmation.
    const warn = () => play([[587, 0, 0.1], [587, 0.14, 0.1]], { type: "triangle", cutoff: 3000, vol: 0.4 });
    return { ensure, success, error, warn };
  })();

  // ---- Cart (client-side) ---------------------------------------------------
  // 50x50 product thumbnail for bill lines; placeholder icon if no image.
  function lineThumb(imageId) {
    if (imageId) {
      return `<img class="bl-thumb" src="${api.imageUrl(imageId)}" alt="" `
        + `onerror="this.outerHTML='<div class=&quot;bl-thumb ph&quot;>\uD83D\uDCE6</div>'"/>`;
    }
    return `<div class="bl-thumb ph">\uD83D\uDCE6</div>`;
  }

  const cart = {
    lines: [], // {product_id, name, price, discount, qty, imageId}
    manual: [], // {name, price, qty} — one-off items, not in DB
    draftId: null, // server-side draft this cart is bound to (null until first item)
    customerName: "",
    customerMobile: "",
    serialize() {
      return {
        lines: this.lines,
        manual: this.manual,
        discountType: this.discountType || null,
        discountValue: this.discountValue || 0,
        finalAmount: this.finalAmount == null ? null : this.finalAmount,
      };
    },
    restore(payload, draftId, customerName) {
      const p = payload || {};
      this.lines = Array.isArray(p.lines) ? p.lines : [];
      this.manual = Array.isArray(p.manual) ? p.manual : [];
      this.discountType = p.discountType || null;
      this.discountValue = p.discountValue || 0;
      this.finalAmount = p.finalAmount == null ? null : p.finalAmount;
      this.lastProductId = null;
      this.draftId = draftId || null;
      this.customerName = customerName || "";
    },
    add(p) {
      const existing = this.lines.find((l) => l.product_id === p.product_id);
      if (existing) existing.qty += 1;
      else
        this.lines.push({
          product_id: p.product_id,
          name: p.product_name,
          price: p.selling_price,
          discount: p.discount || 0,
          imageId: p.primary_image_id || null,
          qty: 1,
        });
      this.lastProductId = p.product_id;
    },
    addManual(name, price, qty) {
      this.manual.push({ name, price, qty });
      this.finalAmount = null;
    },
    setDiscount(type, value) {
      this.discountType = type; this.discountValue = value; this.finalAmount = null;
    },
    discountAmount() {
      if (!this.discountType || !this.discountValue) return 0;
      const sub = this.total();
      const amt = this.discountType === "percent"
        ? Math.round(sub * this.discountValue) / 100
        : this.discountValue;
      return Math.min(Math.max(0, amt), sub);
    },
    undoLast() {
      if (!this.lines.length) return;
      const last = this.lines[this.lines.length - 1];
      last.qty -= 1;
      if (last.qty <= 0) this.lines.pop();
    },
    setQty(productId, qty) {
      const line = this.lines.find((l) => l.product_id === productId);
      if (!line) return;
      line.qty = Math.max(0, qty);
      if (line.qty === 0) this.lines = this.lines.filter((l) => l.product_id !== productId);
    },
    setManualQty(index, qty) {
      const m = this.manual[index];
      if (!m) return;
      // Manual items keep a minimum of 1 (use Remove to delete a row).
      m.qty = Math.max(1, qty);
    },
    clear() {
      this.lines = [];
      this.manual = [];
      this.lastProductId = null;
      this.finalAmount = null; // manual bargain override
      this.discountType = null; this.discountValue = 0;
      this.draftId = null;
      this.customerName = "";
      this.customerMobile = "";
    },
    count() {
      return this.lines.reduce((s, l) => s + l.qty, 0)
        + this.manual.reduce((s, m) => s + m.qty, 0);
    },
    total() {
      return this.lines.reduce((s, l) => s + (l.price - l.discount) * l.qty, 0)
        + this.manual.reduce((s, m) => s + m.price * m.qty, 0);
    },
    finalTotal() {
      if (this.finalAmount != null) return this.finalAmount;
      return Math.max(0, this.total() - this.discountAmount());
    },
    payload() {
      return this.lines.map((l) => ({ product_id: l.product_id, quantity: l.qty }));
    },
    manualPayload() {
      return this.manual.map((m) => ({ name: m.name, price: m.price, quantity: m.qty }));
    },
    isEmpty() {
      return this.lines.length === 0 && this.manual.length === 0;
    },
  };

  // ---- Draft (hold bill) autosave -------------------------------------------
  // Every cart change is saved to the server, so a draft survives a refresh, an
  // app close, and is visible on all devices. The first item creates the draft.
  let _draftSaveTimer = null;
  let _draftSaving = false;
  function autosaveDraft(immediate) {
    clearTimeout(_draftSaveTimer);
    const run = async () => {
      if (_draftSaving) return;
      // Nothing to save: empty cart that was never a draft.
      if (cart.isEmpty() && !cart.draftId) return;
      _draftSaving = true;
      try {
        if (!cart.draftId) {
          const d = await api.post("/api/drafts", {
            customer_name: cart.customerName || "",
            payload: cart.serialize(),
          });
          cart.draftId = d.id;
          updateDraftBadge();
        } else {
          await api.put("/api/drafts/" + cart.draftId, {
            payload: cart.serialize(),
            customer_name: cart.customerName || "",
          });
        }
      } catch (_) {
        // Offline or transient error — the next change retries.
      } finally {
        _draftSaving = false;
      }
    };
    if (immediate) run();
    else _draftSaveTimer = setTimeout(run, 600); // debounce rapid scanning
  }

  // Keeps the "Drafts (n)" badge in sync wherever it's shown.
  async function updateDraftBadge() {
    try {
      const r = await api.get("/api/drafts/count");
      document.querySelectorAll(".draft-badge").forEach((b) => {
        b.textContent = r.active > 0 ? String(r.active) : "";
        b.hidden = !r.active;
      });
    } catch (_) {}
  }

  // ---- Desktop shell --------------------------------------------------------
  const DESKTOP_QUERY = window.matchMedia("(min-width: 768px)");
  function isDesktop() { return DESKTOP_QUERY.matches; }

  function renderSidebar(active) {
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    const map = { product: "products", bill: "history" };
    const act = map[active] || active;
    sb.innerHTML = "";
    // Tablet expand/collapse toggle (hidden on mobile drawer + desktop via CSS).
    const toggle = el(`<button class="rail-toggle" title="Expand / collapse menu" aria-label="Toggle menu">\u2630</button>`);
    toggle.onclick = () => document.getElementById("app")?.classList.toggle("rail-expanded");
    sb.appendChild(toggle);
    const logo = el(`<button class="side-logo">
      <img src="/static/img/logo.png" alt="RESVI"/>
      <span class="side-tag">Retail Products Store</span></button>`);
    logo.onclick = () => { closeDrawer(); go("home"); };
    sb.appendChild(logo);
    const nav = el(`<nav class="side-nav"></nav>`);
    [
      ["scan", "New bill", "\uD83D\uDCF3"],
      ["drafts", "Draft bills", "\uD83D\uDCCB"],
      ["replacement", "Replacement", "\uD83D\uDD01"],
      ["products", "Products", "\uD83D\uDCE6"],
      ["categories", "Categories", "\uD83D\uDDC2\uFE0F"],
      ["inventory", "Inventory", "\uD83D\uDCCA"],
      ["history", "Bill history", "\uD83E\uDDFE"],
      ["daily", "Daily sales", "\uD83D\uDCC8"],
      ["cash", "Cash Drawer", "\uD83D\uDCB0"],
      ["reports", "Reports", "\uD83D\uDCC4"],
      ["ai-scan", "AI Scanner (Beta)", "\uD83E\uDDEA"],
      ["settings", "Settings", "\u2699\uFE0F"],
    ].forEach(([r, label, ico]) => {
      const b = el(`<button class="side-item ${act === r ? "active" : ""}" title="${label}">
        <span class="si-ico">${ico}</span><span class="si-label">${label}</span></button>`);
      b.onclick = () => { closeDrawer(); if (r === "scan") startNewBill(); else go(r); };
      nav.appendChild(b);
    });
    sb.appendChild(nav);
  }

  // ---- Router ---------------------------------------------------------------
  const routes = {};
  const route = (name, fn) => (routes[name] = fn);
  // New Bill entry point: show the optional Customer Details popup FIRST, then
  // open the billing screen. Only for genuinely NEW bills — resuming a draft,
  // viewing/printing/editing a bill, refunds and replacements never call this.
  function startNewBill() {
    // Only prompt when starting fresh (no items in the current cart).
    const m = el(`<div class="modal cust-modal"><h3 style="text-align:center">Customer Details</h3>
      <div class="field"><label>Customer Name</label><input class="input cust-name" type="text" placeholder="Optional" autocomplete="off"/></div>
      <div class="field"><label>Phone Number</label><input class="input cust-mobile" type="tel" inputmode="numeric" placeholder="Optional" autocomplete="off"/></div>
      <button class="btn primary cust-continue" style="margin-top:6px">Submit / Continue</button>
      <button class="btn cust-close" style="margin-top:8px;background:#dc2626;color:#fff">\u2715 Close</button></div>`);
    const ref = modal(m);
    const nameEl = m.querySelector(".cust-name");
    const mobileEl = m.querySelector(".cust-mobile");
    // If a known phone is typed, offer to prefill the saved name.
    let lookupT;
    mobileEl.oninput = () => {
      clearTimeout(lookupT);
      const mob = mobileEl.value.trim();
      if (mob.length < 6) return;
      lookupT = setTimeout(async () => {
        try {
          const cust = await api.get("/api/customers/lookup?mobile=" + encodeURIComponent(mob));
          if (cust && cust.name && !nameEl.value.trim()) nameEl.value = cust.name;
        } catch (_) {}
      }, 350);
    };
    const proceed = (withDetails) => {
      cart.customerName = withDetails ? nameEl.value.trim() : "";
      cart.customerMobile = withDetails ? mobileEl.value.trim() : "";
      ref.resolve();
      go("scan");
    };
    m.querySelector(".cust-continue").onclick = () => proceed(true);
    m.querySelector(".cust-close").onclick = () => proceed(false);   // skip, open bill anyway
    setTimeout(() => nameEl.focus(), 50);
  }

  function go(name, params) {
    location.hash = name + (params ? "?" + new URLSearchParams(params) : "");
  }
  async function render() {
    const [name, qs] = (location.hash.replace(/^#/, "") || "home").split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const fn = routes[name] || routes.home;
    if (name !== "scan") stopCamera(); // leaving scan tears the camera down
    if (name !== "scan") stopBarcodeScanner();
    if (name !== "ai-scan") stopCamera();
    renderSidebar(name);
    closeDrawer(); // any navigation closes the mobile drawer
    view.innerHTML = "";
    view.classList.remove("scan-active");
    try {
      await fn(params);
    } catch (e) {
      view.appendChild(errorBlock(e.message || "Something went wrong."));
    }
  }
  window.addEventListener("hashchange", render);
  // Re-render when crossing the desktop/mobile breakpoint so the layout swaps.
  DESKTOP_QUERY.addEventListener("change", render);
  // Tapping the scrim closes the drawer.
  document.getElementById("drawer-scrim")?.addEventListener("click", closeDrawer);

  // --- Multi-device sync: poll a shared-data fingerprint; refresh on change ---
  // Screens that show shared data get auto-refreshed when another device makes
  // a change. The active billing screens are left alone so scanning/typing is
  // never interrupted; a new bill there already writes to the shared DB.
  let _lastDataVersion = null;
  let _lastSyncAt = null;
  const REFRESH_SCREENS = new Set(["home", "products", "inventory", "history", "daily", "categories"]);
  function updateSyncBadge() {
    const badges = document.querySelectorAll(".sync-badge");
    if (!badges.length) return;
    const txt = _lastSyncAt ? "Synced " + _lastSyncAt.toLocaleTimeString() : "Not synced yet";
    badges.forEach((b) => (b.textContent = txt));
  }
  async function pollDataVersion() {
    if (document.hidden) return;
    try {
      const r = await api.get("/api/system/data-version");
      _lastSyncAt = new Date();
      updateSyncBadge();
      if (_lastDataVersion === null) { _lastDataVersion = r.version; return; }
      if (r.version !== _lastDataVersion) {
        _lastDataVersion = r.version;
        const cur = (location.hash.replace(/^#/, "") || "home").split("?")[0];
        if (REFRESH_SCREENS.has(cur) && !document.querySelector(".modal-back")) {
          render(); // re-pull this screen's data from the shared DB
        }
      }
    } catch (_) { /* offline / transient — try again next tick */ }
  }
  setInterval(pollDataVersion, 5000);
  pollDataVersion();

  // ---- Shared chrome --------------------------------------------------------
  // Shared: edit ONLY the payment method (and split amounts) of a completed bill.
  // onSaved() is called after a successful save so callers can refresh their view.
  function editBillPayment(b, onSaved) {
    let method = (b.payment_method || "cash").toLowerCase();
    const total = b.grand_total || 0;
    const m = el(`<div class="modal"><h3>Edit Payment Method</h3>
      <div class="sub">${b.bill_number} \u00B7 ${money(total)}</div>
      <div class="muted sm" style="margin:6px 0 10px">Only the payment method changes. Items, prices and stock are not affected.</div>
      <div class="pay-grid">
        <button class="pay-opt em-opt" data-m="cash">\uD83D\uDCB5 Cash</button>
        <button class="pay-opt em-opt" data-m="upi">\uD83D\uDCF1 UPI</button>
        <button class="pay-opt em-opt" data-m="card">\uD83D\uDCB3 Card</button>
        <button class="pay-opt em-opt" data-m="split">\u2702\uFE0F Split</button>
      </div>
      <div class="em-split" hidden style="margin-top:10px">
        <div class="field"><label>\uD83D\uDCB5 Cash</label><input class="input es-cash" type="number" inputmode="decimal" value="0"/></div>
        <div class="field"><label>\uD83D\uDCF1 UPI</label><input class="input es-upi" type="number" inputmode="decimal" value="0"/></div>
        <div class="field"><label>\uD83D\uDCB3 Card</label><input class="input es-card" type="number" inputmode="decimal" value="0"/></div>
        <div class="es-remaining" style="font-weight:700;margin:6px 0"></div>
      </div>
      <button class="btn primary em-save" style="margin-top:12px">Save changes</button>
      <button class="btn ghost em-cancel" style="margin-top:8px">Cancel</button></div>`);
    const ref = modal(m);
    const splitBox = m.querySelector(".em-split");
    const markActive = () => m.querySelectorAll(".em-opt").forEach((x) => x.classList.toggle("active", x.dataset.m === method));
    const get = (c) => parseFloat(m.querySelector(c).value) || 0;
    const updSplit = () => {
      const paid = get(".es-cash") + get(".es-upi") + get(".es-card");
      const rem = Math.round((total - paid) * 100) / 100;
      const elx = m.querySelector(".es-remaining");
      elx.textContent = rem === 0 ? "\u2713 Balanced" : (rem > 0 ? `Remaining: ${money(rem)}` : `Over by ${money(-rem)}`);
      elx.style.color = rem === 0 ? "#15803d" : "#b91c1c";
    };
    if (method === "split" && b.payment_breakdown) {
      m.querySelector(".es-cash").value = b.payment_breakdown.cash || 0;
      m.querySelector(".es-upi").value = b.payment_breakdown.upi || 0;
      m.querySelector(".es-card").value = b.payment_breakdown.card || 0;
    }
    const syncSplitVisible = () => { splitBox.hidden = method !== "split"; if (method === "split") updSplit(); };
    m.querySelectorAll(".em-opt").forEach((btn) => {
      btn.onclick = () => { method = btn.dataset.m; markActive(); syncSplitVisible(); };
    });
    m.querySelectorAll(".em-split input").forEach((i) => (i.oninput = updSplit));
    markActive(); syncSplitVisible();
    m.querySelector(".em-cancel").onclick = () => ref.resolve();
    m.querySelector(".em-save").onclick = async () => {
      const body = { payment_method: method };
      if (method === "split") {
        const parts = { cash: get(".es-cash"), upi: get(".es-upi"), card: get(".es-card") };
        if (Math.round((parts.cash + parts.upi + parts.card) * 100) / 100 !== Math.round(total * 100) / 100) {
          alert("Split amounts must add up to the bill total."); return;
        }
        body.payment_split = parts;
      }
      if (!confirm(`Change payment method of ${b.bill_number} to ${method.toUpperCase()}?`)) return;
      try {
        await api.put(`/api/bills/${b.id}/payment-method`, body);
        ref.resolve();
        globalToast("Bill updated successfully");
        if (onSaved) onSaved();
      } catch (e) { alert(e.message); }
    };
  }

  function topbar(title, { back = true } = {}) {
    const bar = el(`<div class="topbar">
      <button class="hamburger" aria-label="Menu">\u2630</button>
      ${back ? '<button class="back" aria-label="Back">\u2039</button>' : ""}
      <h1></h1><div class="spacer"></div>
      <span class="logo-chip"><img src="/static/img/logo.png" alt="RESVI"/></span>
    </div>`);
    bar.querySelector("h1").textContent = title;
    if (back) bar.querySelector(".back").onclick = () => history.back();
    bar.querySelector(".hamburger").onclick = () => openDrawer();
    return bar;
  }

  // Mobile navigation drawer: slides the sidebar in with a scrim.
  function openDrawer() {
    document.getElementById("app")?.classList.add("drawer-open");
  }
  function closeDrawer() {
    document.getElementById("app")?.classList.remove("drawer-open");
  }
  function screen(cls = "") {
    return el(`<div class="screen ${cls}"></div>`);
  }
  function errorBlock(msg) {
    return el(`<div class="empty"><span class="ico">\u26A0\uFE0F</span>${msg}</div>`);
  }
  function emptyBlock(icon, msg) {
    return el(`<div class="empty"><span class="ico">${icon}</span>${msg}</div>`);
  }

  // ---- Home -----------------------------------------------------------------
  route("home", async () => {
    if (isDesktop()) return homeDashboard();
    const home = el(`<div class="home">
      <div class="topbar"><div class="spacer"></div>
        <span class="logo-chip"><img src="/static/img/logo.png" alt="RESVI"/></span></div>
      <div class="hero"><div class="hero-brand">
        <img src="/static/img/logo.png" alt="RESVI"/>
        <div class="tagline">Retail Products Store</div>
      </div></div>
      <div class="actions"></div>
    </div>`);
    const actions = home.querySelector(".actions");
    const make = (label, ico, target, primary) => {
      const t = el(`<button class="tile ${primary ? "primary" : ""}">
        <div class="ico">${ico}</div><div class="label">${label}</div></button>`);
      t.onclick = () => { if (target === "scan") startNewBill(); else go(target); };
      return t;
    };
    // Generated from the shared MODULES list so mobile shows every module and
    // future modules appear automatically. Scan + Voice are highlighted.
    MODULES.forEach((m) => {
      const primary = m.target === "scan" || m.target === "scan?voice=1";
      actions.appendChild(make(m.label, m.icon, m.target, primary));
    });
    view.appendChild(home);
  });

  async function homeDashboard() {
    view.appendChild(topbar("Dashboard", { back: false }));
    const s = screen("dash");
    s.appendChild(el(`<div class="dash-hello">
      <div><h2>Welcome back</h2><div class="muted">Here's your store at a glance.</div></div>
      <button class="btn primary newbill" style="width:auto;padding:0 26px">\uD83D\uDCF7 New bill</button>
    </div>`));
    s.querySelector(".newbill").onclick = () => startNewBill();

    const stats = el(`<div class="stat-grid"></div>`);
    s.appendChild(stats);
    const statCard = (label, value, accent) =>
      el(`<div class="stat-card ${accent || ""}"><div class="stat-val">${value}</div><div class="stat-lbl">${label}</div></div>`);
    stats.appendChild(statCard("Loading…", "—"));
    s.appendChild(el(`<h3 class="dash-h">Quick actions</h3>`));
    const quick = el(`<div class="quick-grid"></div>`);
    const qa = (label, ico, target, desc) => {
      const c = el(`<button class="quick-card"><div class="qc-ico">${ico}</div>
        <div class="qc-label">${label}</div><div class="qc-desc">${desc}</div></button>`);
      c.onclick = () => go(target);
      return c;
    };
    MODULES.forEach((m) => quick.appendChild(qa(m.label, m.icon, m.target, m.desc)));
    s.appendChild(quick);
    view.appendChild(s);

    // Cash Drawer card (cash-only).
    const cashCard = el(`<div class="card cash-card" style="cursor:pointer"><div class="rep-h">\uD83D\uDCB0 Cash Drawer</div>
      <div class="muted sm">Loading\u2026</div></div>`);
    cashCard.onclick = () => go("cash");
    s.insertBefore(cashCard, quick.previousSibling || quick);
    api.get("/api/cash/status").then((cd) => {
      const refRow = (cd.refunds > 0)
        ? `<div><span>Cash Refunds</span><b style="color:#b91c1c">-${money(cd.refunds)}</b></div>` : "";
      cashCard.innerHTML = `<div class="rep-h">\uD83D\uDCB0 Cash Drawer \u00B7 Today</div>
        <div class="cash-grid">
          <div><span>Opening</span><b>${money(cd.opening_cash)}</b></div>
          <div><span>Cash Sales</span><b>${money(cd.cash_sales)}</b></div>
          <div><span>Expenses</span><b>${money(cd.cash_expenses)}</b></div>
          ${refRow}
          <div><span>Expected</span><b class="net">${money(cd.expected_cash)}</b></div>
        </div>`;
    }).catch(() => { cashCard.remove(); });

    // Active draft (held) bills card.
    const draftCard = el(`<div class="card draft-dash" style="cursor:pointer"><div class="rep-h">\uD83D\uDCCB Draft bills</div>
      <div class="muted sm">Loading\u2026</div></div>`);
    draftCard.onclick = () => go("drafts");
    s.insertBefore(draftCard, cashCard.nextSibling);
    api.get("/api/drafts/count").then((r) => {
      draftCard.innerHTML = `<div class="rep-h">\uD83D\uDCCB Draft bills</div>
        <div class="cash-grid"><div><span>Active</span><b class="net">${r.active}</b></div></div>`;
    }).catch(() => { draftCard.remove(); });

    // Today's replacements / refunds.
    const repCard = el(`<div class="card rep-dash" style="cursor:pointer"><div class="rep-h">\uD83D\uDD01 Replacements</div>
      <div class="muted sm">Loading\u2026</div></div>`);
    repCard.onclick = () => go("replacements");
    s.insertBefore(repCard, draftCard.nextSibling);
    api.get("/api/replacements/today").then((r) => {
      repCard.innerHTML = `<div class="rep-h">\uD83D\uDD01 Replacements \u00B7 Today</div>
        <div class="cash-grid">
          <div><span>Replacements</span><b>${r.replacement_count}</b></div>
          <div><span>Refunds</span><b>${r.refund_count}</b></div>
          <div><span>Refund amount</span><b class="net">${money(r.refund_total)}</b></div>
          <div><span>Collected</span><b>${money(r.collected_total)}</b></div>
        </div>`;
    }).catch(() => { repCard.remove(); });

    // Fill stats from the API.
    try {
      const [products, categories, days, info] = await Promise.all([
        api.get("/api/products"),
        api.get("/api/categories"),
        api.get("/api/sales/daily"),
        api.get("/api/settings/info"),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const t = days.find((d) => d.date === today) || days[0] || { net_sales: 0, num_bills: 0 };
      stats.innerHTML = "";
      stats.appendChild(statCard("Sales (latest day)", money(t.net_sales), "accent-teal"));
      stats.appendChild(statCard("Bills (latest day)", t.num_bills, "accent-amber"));
      stats.appendChild(statCard("Products", products.length, "accent-blue"));
      stats.appendChild(statCard("Categories", categories.length, "accent-green"));
      const lowCard = statCard("Low stock", info.low_stock, "accent-amber");
      const outCard = statCard("Out of stock", info.out_of_stock, "accent-red");
      lowCard.style.cursor = outCard.style.cursor = "pointer";
      lowCard.onclick = outCard.onclick = () => go("inventory");
      stats.appendChild(lowCard);
      stats.appendChild(outCard);
    } catch (e) {
      stats.innerHTML = "";
      stats.appendChild(statCard("Stats unavailable", "—"));
    }
  }

  // ---- Scan -----------------------------------------------------------------
  let camera = { stream: null, timer: null, busy: false, lock: { id: null, missed: 0 }, torch: false };
  let bcScanner = null; // html5-qrcode instance for the barcode scanner

  async function stopBarcodeScanner() {
    if (!bcScanner) return;
    try { await bcScanner.stop(); await bcScanner.clear(); } catch (_) {}
    bcScanner = null;
  }

  // Scan feedback state.
  const PRESENCE = 0.45;     // below this top-score, assume nothing is presented
  let lastErrorAt = 0;       // cooldown so the error sound can't machine-gun
  let scanFlashEl = null;    // the green/red flash overlay on the camera

  function flashScan(kind) { // 'green' | 'red'
    if (!scanFlashEl) return;
    scanFlashEl.className = "scan-flash show-" + kind;
    scanFlashEl.textContent = kind === "green" ? "\u2713" : "\u2717";
    setTimeout(() => { if (scanFlashEl) scanFlashEl.className = "scan-flash"; }, 650);
  }

  function stopCamera() {
    if (camera.timer) clearInterval(camera.timer);
    camera.timer = null;
    if (camera.stream) camera.stream.getTracks().forEach((t) => t.stop());
    camera.stream = null;
    camera.busy = false;
    camera.lock = { id: null, missed: 0 };
    scanFlashEl = null;
  }

  // ---- Barcode scanner (PRIMARY billing flow) -------------------------------
  route("scan", async (params = {}) => {
    document.getElementById("view").classList.add("scan-active");
    view.appendChild(topbar("Barcode Scanner", { back: true }));
    const scr = el(`<div class="scan-screen">
      <div class="scan-wrap bc-wrap">
        <div id="bc-reader" class="bc-reader"></div>
        <div class="scan-flash"></div>
        <div class="scan-status"><span class="ss-dot idle"></span><span class="ss-text">Scanner stopped</span></div>
        <div class="toast">Added</div>
        <div class="bc-controls">
          <button class="btn primary start">\u25B6 Start scanner</button>
          <button class="btn ghost stop" disabled>\u25A0 Stop</button>
        </div>
        <div class="bc-manual">
          <input class="input bc-input" type="text" inputmode="text" autocomplete="off"
                 placeholder="\uD83D\uDD0D Search product or barcode" aria-label="Search product or barcode"/>
          <button class="btn ghost sm bc-mic" title="Voice search" aria-label="Voice search" style="width:auto">\uD83C\uDF99\uFE0F</button>
          <button class="btn primary sm bc-go" style="width:auto">Find</button>
        </div>
        <div class="bc-hint muted">\uD83D\uDCF7 Scan a barcode \u00B7 \u2328\uFE0F type a name/code \u00B7 \uD83C\uDF99\uFE0F tap mic to speak</div>
      </div>
      <div class="billpanel">
        <div class="billpanel-head"><span>Current bill</span></div>
        <div class="scan-cta" hidden></div>
        <div class="bc-found" hidden></div>
        <div class="bill-list"></div>
        <div class="billbar">
          <div class="bill-totals">
            <div class="bt-row"><span class="bt-count"></span><span class="bt-sub"></span></div>
            <div class="bt-row bt-disc-row" hidden><span>Discount</span><span class="bt-disc"></span></div>
            <div class="bt-row bt-final"><span>Final Amount</span><span class="bt-total"></span></div>
          </div>
          <button class="btn ghost sm add-discount" style="width:auto">\uD83C\uDFF7\uFE0F Discount</button>
          <button class="btn ghost sm edit-final" style="width:auto">\u270F\uFE0F Edit Final Amount</button>
          <div class="actions">
            <button class="btn ghost add-manual">\u2795 Add Manual Item</button>
          </div>
          <div class="actions">
            <button class="btn ghost drafts-btn">\uD83D\uDCCB Drafts <span class="draft-badge pill" hidden></span></button>
            <button class="btn ghost hold-btn">\uD83D\uDCE5 Hold &amp; New</button>
          </div>
          <div class="actions">
            <button class="btn ghost undo">Undo last</button>
            <button class="btn primary complete">Complete bill</button>
          </div>
        </div>
      </div>
    </div>`);
    view.appendChild(scr);

    const listEl = scr.querySelector(".bill-list");
    const ssDot = scr.querySelector(".ss-dot");
    const ssText = scr.querySelector(".ss-text");
    const toast = scr.querySelector(".toast");
    const foundEl = scr.querySelector(".bc-found");
    scanFlashEl = scr.querySelector(".scan-flash");
    Sound.ensure();

    const setStatus = (state, text) => { ssDot.className = "ss-dot " + state; if (text != null) ssText.textContent = text; };

    const refreshBill = () => {
      autosaveDraft();   // hold-bill autosave: persist every cart change
      const count = cart.count();
      const sub = cart.total();
      const final = cart.finalTotal();
      const disc = Math.max(0, sub - final);
      scr.querySelector(".bt-count").textContent = count + " item" + (count === 1 ? "" : "s");
      scr.querySelector(".bt-sub").textContent = money(sub);
      const discRow = scr.querySelector(".bt-disc-row");
      if (disc > 0) { discRow.hidden = false; scr.querySelector(".bt-disc").textContent = "\u2212" + money(disc); }
      else { discRow.hidden = true; }
      scr.querySelector(".bt-total").textContent = money(final);
      listEl.innerHTML = "";
      if (cart.isEmpty()) { listEl.appendChild(el(`<div class="bill-empty">No items yet.<br/>Scan a barcode or add a manual item.</div>`)); return; }
      cart.lines.forEach((l) => {
        const row = el(`<div class="bill-line">
          ${lineThumb(l.imageId)}
          <div class="bl-name">${l.name}<div class="bl-unit">${money(l.price - l.discount)} each</div></div>
          <div class="bl-qty"><button class="minus">\u2212</button><span>${l.qty}</span><button class="plus">+</button></div>
          <div class="bl-amt">${money((l.price - l.discount) * l.qty)}</div></div>`);
        row.querySelector(".minus").onclick = () => { cart.setQty(l.product_id, l.qty - 1); cart.finalAmount = null; refreshBill(); };
        row.querySelector(".plus").onclick = () => { cart.setQty(l.product_id, l.qty + 1); cart.finalAmount = null; refreshBill(); };
        listEl.appendChild(row);
      });
      // Manual (one-off) items — same [-] n [+] control as normal products.
      cart.manual.forEach((m, i) => {
        const row = el(`<div class="bill-line">
          <div class="bl-thumb ph">\u270F\uFE0F</div>
          <div class="bl-name">${m.name}<div class="bl-unit">manual \u00B7 ${money(m.price)} each</div></div>
          <div class="bl-qty"><button class="minus">\u2212</button><span>${m.qty}</span><button class="plus">+</button></div>
          <div class="bl-amt">${money(m.price * m.qty)} <button class="mrm" title="Remove" style="border:none;background:none;cursor:pointer;color:#b91c1c">\u00D7</button></div></div>`);
        row.querySelector(".minus").onclick = () => { cart.setManualQty(i, m.qty - 1); cart.finalAmount = null; refreshBill(); };
        row.querySelector(".plus").onclick = () => { cart.setManualQty(i, m.qty + 1); cart.finalAmount = null; refreshBill(); };
        row.querySelector(".mrm").onclick = () => { cart.manual.splice(i, 1); cart.finalAmount = null; refreshBill(); };
        listEl.appendChild(row);
      });
    };
    refreshBill();
    updateDraftBadge();
    scr.querySelector(".drafts-btn").onclick = () => go("drafts");
    // "Hold & New": the current cart is already autosaved as a draft, so we just
    // detach from it and start a fresh bill. Nothing is lost.
    scr.querySelector(".hold-btn").onclick = async () => {
      if (cart.isEmpty()) { alert("Add items before holding this bill."); return; }
      autosaveDraft(true);                    // flush immediately
      const name = prompt("Customer name for this held bill (optional):", cart.customerName || "");
      if (name !== null && cart.draftId) {
        try { await api.put("/api/drafts/" + cart.draftId, { customer_name: name, payload: cart.serialize() }); } catch (_) {}
      }
      cart.clear();
      refreshBill();
      updateDraftBadge();
      globalToast("Bill held \u2014 started a new one");
    };
    scr.querySelector(".undo").onclick = () => { cart.undoLast(); cart.finalAmount = null; vibrate(10); refreshBill(); };
    scr.querySelector(".complete").onclick = () => completeBill(refreshBill);
    // Manual final amount (bargain).
    scr.querySelector(".edit-final").onclick = async () => {
      if (!cart.count()) { alert("Add items to the bill first."); return; }
      const sub = cart.total();
      const entered = prompt(`Subtotal is ${money(sub)}.\nEnter the final amount to collect:`, String(Math.round(cart.finalTotal())));
      if (entered === null) return;
      const val = parseFloat(entered);
      if (isNaN(val) || val < 0) { alert("Enter a valid amount (0 or more)."); return; }
      if (val > sub) { alert("Final amount cannot exceed the subtotal of " + money(sub) + "."); return; }
      cart.finalAmount = Math.round(val * 100) / 100;
      refreshBill();
    };
    // Add a one-off manual item (not saved to products/inventory).
    scr.querySelector(".add-manual").onclick = () => {
      const name = prompt("Manual item name (e.g. Chocolate, Scale):");
      if (name === null) return;
      if (!name.trim()) { alert("Enter a name."); return; }
      const priceStr = prompt(`Price of "${name.trim()}" (\u20B9):`, "0");
      if (priceStr === null) return;
      const price = parseFloat(priceStr);
      if (isNaN(price) || price < 0) { alert("Enter a valid price."); return; }
      const qtyStr = prompt("Quantity:", "1");
      if (qtyStr === null) return;
      const qty = parseInt(qtyStr, 10);
      if (isNaN(qty) || qty < 1) { alert("Enter a valid quantity."); return; }
      cart.addManual(name.trim(), Math.round(price * 100) / 100, qty);
      refreshBill();
    };
    // Dynamic discount: percentage or fixed amount.
    scr.querySelector(".add-discount").onclick = async () => {
      if (!cart.count()) { alert("Add items to the bill first."); return; }
      const sub = cart.total();
      const chosen = await new Promise((resolve) => {
        const m = el(`<div class="modal"><h3>Discount</h3>
          <div class="sub">Subtotal: ${money(sub)}</div>
          <div class="disc-type" style="display:flex;gap:8px;margin:10px 0">
            <button class="btn ghost dt-opt active" data-t="percent">Percentage (%)</button>
            <button class="btn ghost dt-opt" data-t="fixed">Fixed (\u20B9)</button>
          </div>
          <div class="field"><label>Discount value</label><input class="input dv" type="number" inputmode="decimal" value="0"/></div>
          <div class="disc-preview" style="font-weight:700;margin:6px 0"></div>
          <button class="btn primary dc-ok">Apply Discount</button>
          <button class="btn ghost dc-clear" style="margin-top:8px">Remove discount</button>
          <button class="btn ghost dc-cancel" style="margin-top:8px">Cancel</button></div>`);
        const ref = modal(m);
        let type = cart.discountType || "percent";
        const setActive = () => m.querySelectorAll(".dt-opt").forEach((b) => b.classList.toggle("active", b.dataset.t === type));
        if (cart.discountValue) m.querySelector(".dv").value = cart.discountValue;
        setActive();
        const preview = m.querySelector(".disc-preview");
        const calc = () => {
          const v = parseFloat(m.querySelector(".dv").value) || 0;
          const amt = type === "percent" ? Math.round(sub * v) / 100 : v;
          const capped = Math.min(Math.max(0, amt), sub);
          preview.textContent = `Discount ${money(capped)} \u2192 Final ${money(sub - capped)}`;
          preview.style.color = amt > sub ? "#b91c1c" : "#15803d";
          if (amt > sub) preview.textContent = "Discount cannot exceed bill amount.";
        };
        m.querySelectorAll(".dt-opt").forEach((b) => (b.onclick = () => { type = b.dataset.t; setActive(); calc(); }));
        m.querySelector(".dv").oninput = calc; calc();
        m.querySelector(".dc-ok").onclick = () => {
          const v = parseFloat(m.querySelector(".dv").value) || 0;
          const amt = type === "percent" ? Math.round(sub * v) / 100 : v;
          if (amt > sub) { alert("Discount cannot exceed bill amount."); return; }
          if (type === "percent" && v > 100) { alert("Percentage cannot exceed 100%."); return; }
          ref.resolve(); resolve({ type, value: v });
        };
        m.querySelector(".dc-clear").onclick = () => { ref.resolve(); resolve({ type: null, value: 0 }); };
        m.querySelector(".dc-cancel").onclick = () => { ref.resolve(); resolve(undefined); };
      });
      if (chosen === undefined) return;
      cart.setDiscount(chosen.type, chosen.value);
      refreshBill();
    };

    // Show the found product (image + name + price + stock) for confirmation.
    function showFound(p) {
      foundEl.hidden = false;
      const badge = p.stock_status === "out" ? `<span class="pill out">Out of stock</span>`
        : p.stock_status === "low" ? `<span class="pill low">Low stock</span>`
        : `<span class="pill active">In stock: ${p.quantity}</span>`;
      foundEl.innerHTML = `
        ${p.primary_image_id
          ? `<img src="${api.imageUrl(p.primary_image_id)}" alt="" onerror="this.outerHTML='<div class=&quot;bf-ph&quot;>\uD83D\uDCE6</div>'"/>`
          : `<div class="bf-ph">\uD83D\uDCE6</div>`}
        <div class="bf-info"><div class="bf-name">${p.product_name}</div>
          <div class="bf-meta">${p.barcode} \u00B7 <b>${money(p.selling_price)}</b></div>${badge}</div>`;
    }

    let lastLookup = 0;
    async function lookup(code, { fromCamera = false } = {}) {
      code = (code || "").trim();
      if (!code) return;
      if (fromCamera && Date.now() - lastLookup < 1200) return; // debounce camera repeats
      lastLookup = Date.now();
      setStatus("scanning", "Looking up " + code + "\u2026");
      try {
        const p = await api.get("/api/products/by-barcode/" + encodeURIComponent(code));
        cart.add({ product_id: p.id, product_name: p.product_name, selling_price: p.selling_price, discount: p.discount || 0 });
        showFound(p);
        Sound.success(); flashScan("green"); vibrate(30);
        setStatus("ok", "Added: " + p.product_name);
        flashToast(toast, "Added \u00B7 " + p.product_name);
        refreshBill();
      } catch (e) {
        foundEl.hidden = true;
        Sound.error(); flashScan("red");
        setStatus("error", "Product Not Found: " + code);
      }
    }

    // Look up by product name (voice / typed words). One match -> add; many -> suggest.
    // Clean a spoken/typed phrase: drop trailing . , ! ? : ; and collapse spaces.
    function cleanTerm(t) {
      return (t || "")
        .replace(/[.,!?:;]+\s*$/g, "")   // trailing punctuation
        .replace(/\s+/g, " ")            // collapse inner whitespace
        .trim();
    }

    async function lookupByName(rawTerm) {
      const term = cleanTerm(rawTerm);
      if (!term) return;
      setStatus("scanning", "Searching \u201C" + term + "\u201D\u2026");
      flashToast(toast, "Searching\u2026");
      let items = [];
      try { items = await api.get("/api/products?active=1&q=" + encodeURIComponent(term)); } catch (_) {}
      // Fuzzy fallback: if the server search misses (e.g. "uno redbox"), match
      // client-side on collapsed/space-insensitive names.
      if (!items.length) {
        try {
          const all = await api.get("/api/products?active=1");
          const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const t = norm(term);
          items = all.filter((p) => norm(p.product_name).includes(t) || t.includes(norm(p.product_name)));
        } catch (_) {}
      }
      if (!items.length) {
        Sound.error(); flashScan("red");
        setStatus("error", `No product matched \u201C${term}\u201D.`);
        return;
      }
      if (items.length === 1) {
        const p = items[0];
        cart.add({ product_id: p.id, product_name: p.product_name, selling_price: p.selling_price, discount: p.discount || 0, primary_image_id: p.primary_image_id });
        showFound(p);
        Sound.success(); flashScan("green"); vibrate(30);
        setStatus("ok", "Added: " + p.product_name);
        flashToast(toast, "Product added");
        refreshBill();
        return;
      }
      // Multiple matches -> show tappable suggestions.
      foundEl.hidden = false;
      setStatus("low", items.length + " matches \u2014 tap one");
      foundEl.innerHTML = `<div class="bf-suggest"><div class="bf-suggest-h">Did you mean\u2026</div></div>`;
      const wrap = foundEl.querySelector(".bf-suggest");
      items.slice(0, 6).forEach((p) => {
        const b = el(`<button class="bf-sug-row">
          ${p.primary_image_id ? `<img src="${api.imageUrl(p.primary_image_id)}" alt=""/>` : `<div class="bl-thumb ph">\uD83D\uDCE6</div>`}
          <span class="pr-name">${p.product_name}</span><span class="pr-price">${money(p.selling_price)}</span></button>`);
        b.onclick = () => {
          cart.add({ product_id: p.id, product_name: p.product_name, selling_price: p.selling_price, discount: p.discount || 0, primary_image_id: p.primary_image_id });
          Sound.success(); flashScan("green"); setStatus("ok", "Added: " + p.product_name);
          flashToast(toast, "Product added"); showFound(p); refreshBill();
        };
        wrap.appendChild(b);
      });
    }

    // Manual / USB scanner input: digits -> barcode lookup; words -> name search.
    const bcInput = scr.querySelector(".bc-input");
    const submitManual = () => {
      const v = bcInput.value.trim(); bcInput.value = "";
      if (!v) return;
      if (/^\d+$/.test(v)) lookup(v); else lookupByName(v);
    };
    scr.querySelector(".bc-go").onclick = submitManual;
    bcInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitManual(); } });
    bcInput.focus();

    // Live product suggestions under the scan search box; pick -> add to bill.
    attachAutocomplete(bcInput, (p) => {
      bcInput.value = "";
      cart.add({ product_id: p.id, product_name: p.product_name, selling_price: p.selling_price, discount: p.discount || 0, primary_image_id: p.primary_image_id });
      showFound(p);
      Sound.success(); flashScan("green"); vibrate(20);
      setStatus("ok", "Added: " + p.product_name);
      flashToast(toast, "Product added");
      refreshBill();
    });

    // Voice product search (Web Speech API) — tuned for mobile/tablet.
    const micBtn = scr.querySelector(".bc-mic");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.disabled = true;
      micBtn.title = "Voice search needs Chrome (and HTTPS)";
    } else {
      let listening = false, rec = null;
      const stopListening = () => { listening = false; micBtn.classList.remove("listening"); try { rec && rec.stop(); } catch (_) {} };
      micBtn.onclick = () => {
        if (listening) { stopListening(); return; }   // tap again to cancel
        rec = new SR();
        rec.lang = "en-IN";
        rec.interimResults = true;    // mobile often only emits interim results
        rec.continuous = false;
        rec.maxAlternatives = 3;
        listening = true; micBtn.classList.add("listening");
        setStatus("scanning", "Listening\u2026 speak the product name"); flashToast(toast, "Listening\u2026");
        let best = "";
        rec.onresult = (ev) => {
          // Take the latest transcript (interim or final).
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            best = ev.results[i][0].transcript;
            bcInput.value = best.trim();
            if (ev.results[i].isFinal) {
              const said = cleanTerm(best).toUpperCase();
              bcInput.value = said;
              stopListening();
              lookupByName(said);
              return;
            }
          }
        };
        rec.onerror = (e) => {
          stopListening();
          if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            setStatus("error", "Microphone blocked. Allow mic access for this site.");
          } else if (e.error === "no-speech") {
            setStatus("error", "Didn't catch that \u2014 tap \uD83C\uDF99\uFE0F and speak again.");
          } else {
            setStatus("error", "Voice error (" + e.error + "). Type the name instead.");
          }
          Sound.error();
        };
        rec.onend = () => {
          // If it ended with an interim result but no final, use what we have.
          if (listening) {
            stopListening();
            const said = cleanTerm(best).toUpperCase();
            if (said) { bcInput.value = said; lookupByName(said); }
            else setStatus("error", "Didn't catch that \u2014 tap \uD83C\uDF99\uFE0F to retry.");
          }
        };
        try { rec.start(); } catch (_) { stopListening(); }
      };
      // Auto-open voice search when launched from the home "Voice Search" tile.
      if (params.voice === "1") {
        setTimeout(() => micBtn.click(), 400);
      }
    }

    // Camera scanner via html5-qrcode (optional; manual/USB always works).
    const startBtn = scr.querySelector(".start");
    const stopBtn = scr.querySelector(".stop");
    if (typeof Html5Qrcode === "undefined") {
      setStatus("idle", "Camera library unavailable \u2014 use USB scanner or type barcode");
      startBtn.disabled = true;
    } else {
      startBtn.onclick = async () => {
        try {
          scr.classList.add("cam-on"); // reveal the camera preview
          bcScanner = new Html5Qrcode("bc-reader", { verbose: false });
          await bcScanner.start({ facingMode: "environment" },
            { fps: 10, qrbox: { width: 260, height: 160 } },
            (decoded) => lookup(decoded, { fromCamera: true }),
            () => {});
          startBtn.disabled = true; stopBtn.disabled = false;
          setStatus("scanning", "Point at a barcode\u2026");
        } catch (e) {
          scr.classList.remove("cam-on");
          setStatus("error", "Camera error: " + (e.message || e));
        }
      };
      stopBtn.onclick = async () => {
        await stopBarcodeScanner();
        scr.classList.remove("cam-on");
        startBtn.disabled = false; stopBtn.disabled = true;
        setStatus("idle", "Scanner stopped");
      };
    }
  });

  // ---- Experimental: AI image scanner (kept, no longer the primary flow) ----
  route("ai-scan", async () => {
    const bar = topbar("AI Scanner (Experimental)", { back: true });
    const flash = el(`<button class="round" title="Flash">\u26A1</button>`);
    bar.appendChild(flash);
    view.appendChild(bar);

    const scr = el(`<div class="scan-screen">
      <div class="scan-wrap">
        <video class="scan-video" autoplay playsinline muted></video>
        <div class="guide"></div>
        <div class="scan-flash"></div>
        <div class="scan-status"><span class="ss-dot idle"></span><span class="ss-text">Starting camera\u2026</span></div>
        <div class="toast">Added</div>
      </div>
      <div class="billpanel">
        <div class="billpanel-head"><span>Current bill</span>
          <button class="dbg-toggle">Debug</button></div>
        <div class="scan-cta" hidden></div>
        <div class="scan-actions-top">
          <button class="btn primary scan-now">\uD83D\uDCF7 Scan product</button>
          <label class="cont-toggle"><input type="checkbox" class="cont" checked/> Auto-scan</label>
        </div>
        <div class="picker">
          <input class="input picker-search" type="text" inputmode="text" enterkeyhint="search" placeholder="\uD83D\uDD0D Search products to add\u2026"/>
          <div class="picker-list"></div>
        </div>
        <div class="bill-list"></div>
        <div class="billbar">
          <div class="summary"><span class="count"></span><span class="total"></span></div>
          <div class="actions">
            <button class="btn ghost undo">Undo last</button>
            <button class="btn primary complete">Complete bill</button>
          </div>
        </div>
        <div class="debug-panel" hidden></div>
      </div>
    </div>`);
    view.appendChild(scr);

    const wrap = scr.querySelector(".scan-wrap");
    const video = scr.querySelector("video");
    const guide = scr.querySelector(".guide");
    const toast = scr.querySelector(".toast");
    const listEl = scr.querySelector(".bill-list");
    const ssDot = scr.querySelector(".ss-dot");
    const ssText = scr.querySelector(".ss-text");
    const dbgPanel = scr.querySelector(".debug-panel");
    const ctaEl = scr.querySelector(".scan-cta");
    scanFlashEl = scr.querySelector(".scan-flash");

    const dbg = { model: "?", frames: 0, lastLatency: 0, lastDecision: "—", candidates: [], lastError: null };
    let dbgOpen = false;

    function setStatus(state, text) {
      ssDot.className = "ss-dot " + state;
      if (text != null) ssText.textContent = text;
    }
    function renderDbg() {
      if (!dbgOpen) return;
      const cands = (dbg.candidates || [])
        .map((c) => `<div class="dbg-row"><span>${c.product_name}</span><b>${(c.score * 100).toFixed(1)}%</b></div>`)
        .join("") || '<div class="dbg-row muted">no candidates</div>';
      dbgPanel.innerHTML = `
        <div class="dbg-line"><span>Recognizer</span><b>${dbg.model}</b></div>
        <div class="dbg-line"><span>Scans sent</span><b>${dbg.frames}</b></div>
        <div class="dbg-line"><span>Last latency</span><b>${dbg.lastLatency} ms</b></div>
        <div class="dbg-line"><span>Last decision</span><b>${dbg.lastDecision}</b></div>
        ${dbg.lastError ? `<div class="dbg-line err"><span>Last error</span><b>${dbg.lastError}</b></div>` : ""}
        <div class="dbg-sub">Top candidates</div>${cands}`;
    }
    scr.querySelector(".dbg-toggle").onclick = () => {
      dbgOpen = !dbgOpen;
      dbgPanel.hidden = !dbgOpen;
      renderDbg();
    };

    const refreshBill = () => {
      autosaveDraft();   // hold-bill autosave: persist every cart change
      scr.querySelector(".count").textContent = cart.count() + " item" + (cart.count() === 1 ? "" : "s");
      scr.querySelector(".total").textContent = money(cart.total());
      listEl.innerHTML = "";
      if (!cart.lines.length && !cart.manual.length) {
        listEl.appendChild(el(`<div class="bill-empty">No items yet.<br/>Scan a product to begin.</div>`));
        return;
      }
      cart.lines.forEach((l) => {
        const row = el(`<div class="bill-line">
          ${lineThumb(l.imageId)}
          <div class="bl-name">${l.name}<div class="bl-unit">${money(l.price - l.discount)} each</div></div>
          <div class="bl-qty"><button class="minus">\u2212</button><span>${l.qty}</span><button class="plus">+</button></div>
          <div class="bl-amt">${money((l.price - l.discount) * l.qty)}</div></div>`);
        row.querySelector(".minus").onclick = () => { cart.setQty(l.product_id, l.qty - 1); refreshBill(); };
        row.querySelector(".plus").onclick = () => { cart.setQty(l.product_id, l.qty + 1); refreshBill(); };
        listEl.appendChild(row);
      });
      // Manual (one-off) items — same [-] n [+] control as normal products.
      cart.manual.forEach((m, i) => {
        const row = el(`<div class="bill-line">
          <div class="bl-thumb ph">\u270F\uFE0F</div>
          <div class="bl-name">${m.name}<div class="bl-unit">manual \u00B7 ${money(m.price)} each</div></div>
          <div class="bl-qty"><button class="minus">\u2212</button><span>${m.qty}</span><button class="plus">+</button></div>
          <div class="bl-amt">${money(m.price * m.qty)} <button class="mrm" title="Remove" style="border:none;background:none;cursor:pointer;color:#b91c1c">\u00D7</button></div></div>`);
        row.querySelector(".minus").onclick = () => { cart.setManualQty(i, m.qty - 1); refreshBill(); };
        row.querySelector(".plus").onclick = () => { cart.setManualQty(i, m.qty + 1); refreshBill(); };
        row.querySelector(".mrm").onclick = () => { cart.manual.splice(i, 1); refreshBill(); };
        listEl.appendChild(row);
      });
    };
    refreshBill();

    scr.querySelector(".undo").onclick = () => { cart.undoLast(); vibrate(10); refreshBill(); };
    scr.querySelector(".complete").onclick = () => completeBill(refreshBill);

    Sound.ensure();

    // --- Recognizer health: warn if nothing is enrolled for this model -------
    try {
      const info = await api.get("/api/settings/info");
      dbg.model = info.recognizer;
      console.log("[scan] recognizer:", info.recognizer, "indexed:", info.indexed_vectors, "products:", info.product_count);
      if (info.indexed_vectors === 0) {
        ctaEl.hidden = false;
        if (info.product_count === 0) {
          ctaEl.innerHTML = `<b>No products yet.</b> Add products before scanning.
            <button class="btn sm primary" style="margin-top:8px">Add a product</button>`;
          ctaEl.querySelector("button").onclick = () => go("product");
        } else {
          ctaEl.innerHTML = `<b>Recognition not built.</b> Your products aren't embedded for the current recognizer.
            <button class="btn sm primary rebuild" style="margin-top:8px">Rebuild recognition</button>`;
          ctaEl.querySelector(".rebuild").onclick = async (e) => {
            e.target.textContent = "Rebuilding\u2026"; e.target.disabled = true;
            try { const r = await api.post("/api/settings/reindex"); console.log("[scan] reindex:", r); ctaEl.hidden = true; }
            catch (err) { e.target.textContent = "Failed: " + err.message; }
          };
        }
      }
    } catch (e) {
      console.warn("[scan] info fetch failed", e);
    }

    // --- Camera --------------------------------------------------------------
    try {
      camera.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = camera.stream;
      setStatus("scanning", "Camera ready \u2014 scanning\u2026");
      console.log("[scan] camera started");
    } catch (e) {
      console.error("[scan] camera error", e);
      setStatus("error", "Camera unavailable: " + (e.message || e.name));
      guide.classList.add("state-manual");
      Sound.error();
      dbg.lastError = "camera: " + (e.name || e.message); renderDbg();
      return;
    }

    flash.onclick = async () => {
      const track = camera.stream.getVideoTracks()[0];
      try { camera.torch = !camera.torch; await track.applyConstraints({ advanced: [{ torch: camera.torch }] }); }
      catch (_) {}
    };

    const canvas = document.createElement("canvas");
    const captureBlob = () =>
      new Promise((resolve) => {
        if (!video.videoWidth) return resolve(null);
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
      });

    function applyResult(res, manual) {
      setGuideState(guide, res.decision);
      const top = res.top;

      // Face / non-product frame.
      if (res.decision === "face") {
        camera.lock = { id: null, missed: 0 };
        setStatus("error", res.message || "Face detected. Please scan a product.");
        if (manual) { Sound.warn(); flashScan("red"); }
        return;
      }

      // Continuous dup-lock housekeeping.
      if (!manual && camera.lock.id != null) {
        if (top && top.product_id === camera.lock.id && res.decision === "auto_add") {
          setStatus("ok", top.product_name);
          camera.lock.missed = 0;
          return;
        }
        camera.lock.missed += 1;
        if (camera.lock.missed >= 2) camera.lock = { id: null, missed: 0 };
      }

      if (res.decision === "auto_add" && top) {
        cart.add(top);
        camera.lock = { id: top.product_id, missed: 0 };
        Sound.success(); flashScan("green"); vibrate(35);
        setStatus("ok", "Added: " + top.product_name);
        flashToast(toast, "Added \u00B7 " + top.product_name);
        refreshBill();
        return;
      }
      if (res.decision === "confirm" && top) {
        setStatus("low", "Choose the product \u2014 top matches below");
        if (!manual && camera.lock.id === top.product_id) return;
        camera.lock = { id: top.product_id, missed: 0 };
        Sound.warn();
        openConfirm(res, refreshBill);
        return;
      }
      // no confident match
      setStatus("low", "No product detected \u2014 pick it below");
      if (manual) {
        Sound.error(); flashScan("red");
      }
    }

    async function doScan(manual) {
      if (document.querySelector(".modal-back")) return; // a dialog is open
      const blob = await captureBlob();
      if (!blob) { if (manual) setStatus("error", "Camera not ready yet"); return; }
      const fd = new FormData();
      fd.append("frame", blob, "frame.jpg");
      if (manual) setStatus("scanning", "Scanning\u2026");
      const t0 = performance.now();
      let res;
      try {
        res = await api.form("/api/scan", fd);
      } catch (e) {
        dbg.frames++; dbg.lastError = e.message; renderDbg();
        console.error("[scan] request failed", e);
        setStatus("error", "Scan error: " + e.message);
        if (manual || Date.now() - lastErrorAt > 3000) { Sound.error(); flashScan("red"); lastErrorAt = Date.now(); }
        return;
      }
      dbg.frames++;
      dbg.lastLatency = Math.round(performance.now() - t0);
      dbg.lastDecision = res.decision;
      dbg.candidates = res.candidates || [];
      dbg.lastError = null;
      renderDbg();
      console.log("[scan] result", { decision: res.decision, top: res.top, latency: dbg.lastLatency });
      applyResult(res, manual);
    }

    scr.querySelector(".scan-now").onclick = () => doScan(true);

    // --- Manual product picker (search + tap to add) -------------------------
    const pickerSearch = scr.querySelector(".picker-search");
    const pickerList = scr.querySelector(".picker-list");
    function addProduct(p) {
      cart.add({
        product_id: p.id,
        product_name: p.product_name,
        selling_price: p.selling_price,
        discount: p.discount || 0,
      });
      Sound.success(); flashScan("green"); vibrate(20);
      setStatus("ok", "Added: " + p.product_name);
      refreshBill();
    }
    async function loadPicker(term) {
      try {
        const items = await api.get("/api/products?active=1" + (term ? "&q=" + encodeURIComponent(term) : ""));
        pickerList.innerHTML = "";
        if (!items.length) { pickerList.appendChild(el(`<div class="picker-empty">No products found</div>`)); return; }
        items.forEach((p) => {
          const row = el(`<button class="picker-row">
            <img src="${p.primary_image_id ? api.imageUrl(p.primary_image_id) : ""}" alt=""/>
            <span class="pr-name">${p.product_name}</span>
            <span class="pr-price">${money(p.selling_price)}</span></button>`);
          row.onclick = () => addProduct(p);
          pickerList.appendChild(row);
        });
      } catch (e) { console.error("[picker] load failed", e); }
    }
    let pkt;
    pickerSearch.oninput = () => { clearTimeout(pkt); pkt = setTimeout(() => loadPicker(pickerSearch.value.trim()), 200); };
    loadPicker("");
    const contChk = scr.querySelector(".cont");

    async function tick() {
      if (camera.busy || document.hidden || !contChk.checked) return;
      camera.busy = true;
      try { await doScan(false); } finally { camera.busy = false; }
    }
    camera.timer = setInterval(tick, 700);
  });

  function setGuideState(guide, decision) {
    guide.classList.remove("state-auto", "state-confirm", "state-manual");
    if (decision === "auto_add") guide.classList.add("state-auto");
    else if (decision === "confirm") guide.classList.add("state-confirm");
    else if (decision === "manual") guide.classList.add("state-manual");
  }

  function flashToast(toast, text) {
    toast.textContent = text;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 900);
  }

  // A floating toast not tied to a specific screen element.
  function globalToast(text) {
    let t = document.querySelector(".global-toast");
    if (!t) { t = el(`<div class="toast global-toast"></div>`); document.body.appendChild(t); }
    t.textContent = text; t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
  }

  /**
   * Attach a live product-suggestions dropdown to a text input.
   * onPick(product) fires when a suggestion is chosen (click / Enter).
   * Real-time, case-insensitive, keyboard-navigable, mobile/tablet friendly.
   */
  function attachAutocomplete(input, onPick, { activeOnly = true } = {}) {
    const box = el(`<div class="ac-box" hidden></div>`);
    // Position relative to the input's wrapper.
    const holder = input.parentElement;
    if (getComputedStyle(holder).position === "static") holder.style.position = "relative";
    holder.appendChild(box);

    let items = [], hi = -1, timer = null, lastQ = "";

    const close = () => { box.hidden = true; box.innerHTML = ""; hi = -1; };
    const render = () => {
      box.innerHTML = "";
      if (!items.length) { close(); return; }
      items.forEach((p, i) => {
        const row = el(`<button type="button" class="ac-row ${i === hi ? "hi" : ""}">
          ${p.primary_image_id ? `<img src="${api.imageUrl(p.primary_image_id)}" alt=""/>` : `<span class="ac-ph">\uD83D\uDCE6</span>`}
          <span class="ac-name">${p.product_name}</span>
          <span class="ac-price">${money(p.selling_price)}</span></button>`);
        row.onmousedown = (e) => { e.preventDefault(); choose(i); };
        box.appendChild(row);
      });
      box.hidden = false;
    };
    const choose = (i) => {
      const p = items[i]; if (!p) return;
      close();
      onPick(p);
    };
    const fetchSuggest = async (q) => {
      try {
        const res = await api.get(`/api/products?${activeOnly ? "active=1&" : ""}q=${encodeURIComponent(q)}`);
        items = res.slice(0, 8); hi = -1; render();
      } catch (_) { close(); }
    };

    input.addEventListener("input", () => {
      const q = input.value.trim();
      lastQ = q;
      clearTimeout(timer);
      if (!q) { close(); return; }
      timer = setTimeout(() => { if (input.value.trim() === lastQ) fetchSuggest(lastQ); }, 150);
    });
    input.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); render(); }
      else if (e.key === "Enter" && hi >= 0) { e.preventDefault(); choose(hi); }
      else if (e.key === "Escape") { close(); }
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    return { close };
  }

  function handleScan(res, guide, toast, refreshBill) {
    const top = res.top;
    const score = top ? top.score : 0;

    // Nothing meaningfully presented (empty counter) -> idle, no sound/flash.
    if (!top || score < PRESENCE) {
      setGuideState(guide, "idle");
      if (camera.lock.id != null) {
        camera.lock.missed += 1;
        if (camera.lock.missed >= 2) camera.lock = { id: null, missed: 0 };
      }
      return;
    }

    setGuideState(guide, res.decision);

    // Duplicate-scan lock: don't re-add the same product sitting in frame.
    if (camera.lock.id != null) {
      if (top.product_id === camera.lock.id) { camera.lock.missed = 0; return; }
      camera.lock.missed += 1;
      if (camera.lock.missed >= 2) camera.lock = { id: null, missed: 0 };
    }

    // SUCCESS: confident match -> add, green flash, beep.
    if (res.decision === "auto_add") {
      cart.add(top);
      camera.lock = { id: top.product_id, missed: 0 };
      Sound.success();
      flashScan("green");
      vibrate(35);
      flashToast(toast, "Added \u00B7 " + top.product_name);
      refreshBill();
      return;
    }

    // UNCERTAIN: ask the user to confirm (amber). Pick -> success, cancel -> error.
    if (res.decision === "confirm") {
      if (camera.lock.id === top.product_id) return;
      openConfirm(res, refreshBill);
      camera.lock = { id: top.product_id, missed: 0 };
      return;
    }

    // FAILURE: a product was presented but not identified -> red flash, error sound.
    const now = Date.now();
    if (now - lastErrorAt > 2500) {
      Sound.error();
      flashScan("red");
      lastErrorAt = now;
    }
    if ((res.candidates || []).length) openManual(res, refreshBill);
    camera.lock = { id: -1, missed: 0 };
  }

  // ---- Modals ---------------------------------------------------------------
  function modal(node, { onCancel, dismissable = true } = {}) {
    let done = false;
    const back = el(`<div class="modal-back"></div>`);
    back.appendChild(node);
    function finish(picked) {
      if (done) return;
      done = true;
      if (!picked && onCancel) onCancel();
      back.remove();
      camera.lock = { id: null, missed: 0 };
    }
    back.onclick = (e) => { if (dismissable && e.target === back) finish(false); };
    document.body.appendChild(back);
    return { resolve: () => finish(true), cancel: () => finish(false) };
  }

  function pickRow(c, onPick) {
    const row = el(`<div class="pick">
      <img class="thumb" src="${c.primary_image_id ? api.imageUrl(c.primary_image_id) : ""}" alt=""/>
      <div><div class="name">${c.product_name}</div>
        <div class="score">${money(c.selling_price)}</div></div>
      <button class="btn sm primary">Add</button></div>`);
    row.querySelector("button").onclick = () => onPick(c);
    return row;
  }

  function openConfirm(res, refreshBill) {
    const sub = res.variant_disambiguation
      ? "Same item in more than one size — pick the exact one."
      : "Confirm the product to add.";
    const m = el(`<div class="modal"><h3>Is this the product?</h3>
      <div class="sub">${sub}</div><div class="list"></div></div>`);
    const list = m.querySelector(".list");
    res.candidates.forEach((c) =>
      list.appendChild(
        pickRow(c, (chosen) => {
          cart.add(chosen);
          Sound.success();
          flashScan("green");
          vibrate(35);
          refreshBill();
          ref.resolve();
        })
      )
    );
    // Closing without choosing = not confirmed -> error feedback.
    const ref = modal(m, { onCancel: () => { Sound.error(); flashScan("red"); } });
  }

  function openManual(res, refreshBill) {
    const m = el(`<div class="modal"><h3>Couldn\u2019t identify the exact product</h3>
      <div class="sub">Pick the correct one, or search.</div>
      <input class="input" type="text" inputmode="text" enterkeyhint="search" placeholder="\uD83D\uDD0D Search product / barcode / category" style="margin-bottom:12px"/>
      <div class="list"></div></div>`);
    const list = m.querySelector(".list");
    const input = m.querySelector("input");
    const fill = (items) => {
      list.innerHTML = "";
      items.forEach((c) =>
        list.appendChild(
          pickRow(
            { ...c, score: c.score ?? 0 },
            (chosen) => {
              cart.add(chosen);
              Sound.success();
              flashScan("green");
              vibrate(35);
              refreshBill();
              ref.resolve();
            }
          )
        )
      );
    };
    fill(res.candidates || []);
    let t;
    input.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const term = input.value.trim();
        const items = await api.get("/api/products?active=1" + (term ? "&q=" + encodeURIComponent(term) : ""));
        fill(items);
      }, 200);
    };
    const ref = modal(m);
  }

  async function completeBill(refreshBill) {
    if (cart.isEmpty()) return;
    const total = cart.finalTotal();
    // Choose payment method first.
    const pay = await new Promise((resolve) => {
      const m = el(`<div class="modal"><h3>Payment method</h3>
        <div class="sub">${cart.count()} item(s) \u00B7 ${money(total)}</div>
        <div class="pay-grid">
          <button class="pay-opt" data-m="cash">\uD83D\uDCB5 Cash</button>
          <button class="pay-opt" data-m="upi">\uD83D\uDCF1 UPI</button>
          <button class="pay-opt" data-m="card">\uD83D\uDCB3 Card</button>
          <button class="pay-opt" data-m="split">\u2702\uFE0F Split</button>
        </div>
        <button class="btn ghost cancel" style="margin-top:10px">Cancel</button></div>`);
      const ref = modal(m);
      m.querySelectorAll(".pay-opt").forEach((b) => (b.onclick = () => { ref.resolve(); resolve(b.dataset.m); }));
      m.querySelector(".cancel").onclick = () => { ref.resolve(); resolve(null); };
    });
    if (!pay) return;

    // Split payment: collect cash/upi/card amounts with live remaining check.
    let split = null;
    if (pay === "split") {
      split = await new Promise((resolve) => {
        const m = el(`<div class="modal"><h3>Split payment</h3>
          <div class="sub">Bill total: ${money(total)}</div>
          <div class="field"><label>\uD83D\uDCB5 Cash</label><input class="input sp-cash" type="number" inputmode="decimal" value="0"/></div>
          <div class="field"><label>\uD83D\uDCF1 UPI</label><input class="input sp-upi" type="number" inputmode="decimal" value="0"/></div>
          <div class="field"><label>\uD83D\uDCB3 Card</label><input class="input sp-card" type="number" inputmode="decimal" value="0"/></div>
          <div class="sp-remaining" style="font-weight:700;margin:8px 0"></div>
          <button class="btn primary sp-ok">Confirm</button>
          <button class="btn ghost sp-cancel" style="margin-top:8px">Cancel</button></div>`);
        const ref = modal(m);
        const get = (c) => parseFloat(m.querySelector(c).value) || 0;
        const rem = m.querySelector(".sp-remaining");
        const update = () => {
          const paid = get(".sp-cash") + get(".sp-upi") + get(".sp-card");
          const r = Math.round((total - paid) * 100) / 100;
          rem.textContent = r === 0 ? "\u2713 Balanced" : (r > 0 ? `Remaining: ${money(r)}` : `Over by ${money(-r)}`);
          rem.style.color = r === 0 ? "#15803d" : "#b91c1c";
        };
        m.querySelectorAll("input").forEach((i) => (i.oninput = update));
        update();
        m.querySelector(".sp-ok").onclick = () => {
          const parts = { cash: get(".sp-cash"), upi: get(".sp-upi"), card: get(".sp-card") };
          const paid = Math.round((parts.cash + parts.upi + parts.card) * 100) / 100;
          if (paid !== Math.round(total * 100) / 100) { alert("Payment total does not match bill amount."); return; }
          ref.resolve(); resolve(parts);
        };
        m.querySelector(".sp-cancel").onclick = () => { ref.resolve(); resolve(null); };
      });
      if (!split) return;
    }
    try {
      const payload = { items: cart.payload(), payment_method: pay };
      if (cart.draftId) payload.draft_id = cart.draftId;
      if (cart.customerName) payload.customer_name = cart.customerName;
      if (cart.customerMobile) payload.customer_mobile = cart.customerMobile;
      if (cart.finalAmount != null) payload.final_amount = cart.finalAmount;
      if (cart.discountType && cart.discountValue) { payload.discount_type = cart.discountType; payload.discount_value = cart.discountValue; }
      if (cart.manual.length) payload.manual_items = cart.manualPayload();
      if (split) payload.payment_split = split;
      const bill = await api.post("/api/bills/complete", payload);
      cart.clear();
      refreshBill();
      updateDraftBadge();
      const discLine = bill.total_discount > 0 ? ` \u00B7 saved ${money(bill.total_discount)}` : "";
      const m = el(`<div class="modal"><h3>Bill saved</h3>
        <div class="sub">${bill.bill_number} \u00B7 ${money(bill.grand_total)} \u00B7 ${bill.payment_method.toUpperCase()}${discLine}</div>
        <button class="btn primary">Start new bill</button></div>`);
      const ref = modal(m);
      m.querySelector("button").onclick = () => ref.resolve();
    } catch (e) {
      alert(e.message);
    }
  }

  // ---- Products -------------------------------------------------------------
  route("products", async () => {
    const tb = topbar("Products");
    view.appendChild(tb);
    const s = screen();
    const head = el(`<div class="searchbar">
      <div class="prod-count muted" style="margin-bottom:8px">Loading count\u2026</div>
      <input class="input" type="text" inputmode="text" enterkeyhint="search" placeholder="\uD83D\uDD0D Search product / barcode / category"/>
      <div class="btn-row" style="margin-top:10px">
        <select class="input"><option value="">All categories</option></select>
        <button class="btn ghost sm import-btn" style="width:auto;white-space:nowrap">\u2B07 Import</button>
        <button class="btn ghost sm export-btn" style="width:auto;white-space:nowrap">\uD83D\uDCC4 Export</button>
        <button class="btn primary sm add-btn" style="width:auto;white-space:nowrap">+ Add</button>
      </div></div>`);
    const listWrap = el(`<div class="list product-grid"></div>`);
    s.appendChild(head);
    s.appendChild(listWrap);
    view.appendChild(s);

    // Product count + stats (auto-reflects imports, archives, deletes).
    (async () => {
      try {
        const st = await api.get("/api/products/stats");
        head.querySelector(".prod-count").innerHTML =
          `<b>Products (${st.active})</b> \u00B7 ${st.archived} archived \u00B7 ${st.categories} categories`;
        const h1 = tb.querySelector("h1");
        if (h1) h1.textContent = `Products (${st.active})`;
      } catch (_) {}
    })();

    const search = head.querySelector('input');
    const catSel = head.querySelector("select");
    head.querySelector(".add-btn").onclick = () => go("product");
    head.querySelector(".import-btn").onclick = () => go("import");
    head.querySelector(".export-btn").onclick = () => {
      window.open("/api/products/export", "_blank");
      globalToast("Exporting all products\u2026");
    };

    const cats = await api.get("/api/categories");
    cats.forEach((c) => catSel.appendChild(el(`<option value="${c.id}">${c.category_name}</option>`)));

    async function load() {
      const q = search.value.trim();
      const cat = catSel.value;
      const url =
        "/api/products" +
        (q || cat ? "?" : "") +
        [q ? "q=" + encodeURIComponent(q) : "", cat ? "category_id=" + cat : ""]
          .filter(Boolean)
          .join("&");
      const items = await api.get(url);
      listWrap.innerHTML = "";
      if (!items.length) return listWrap.appendChild(emptyBlock("\uD83D\uDCE6", "No products yet."));
      items.forEach((p) => listWrap.appendChild(productCard(p, load)));
    }
    let t;
    search.oninput = () => {
      clearTimeout(t);
      t = setTimeout(load, 200);
    };
    // Suggestions dropdown; picking one opens that product.
    attachAutocomplete(search, (p) => { search.value = p.product_name; go("product", { id: p.id }); }, { activeOnly: false });
    catSel.onchange = load;
    await load();
  });

  function productCard(p, reload) {
    const stockCls = p.stock_status === "out" ? "out" : p.stock_status === "low" ? "low" : "ok";
    const stockTxt = p.stock_status === "out" ? "Out of stock" : `In stock: ${p.quantity}`;
    const card = el(`<div class="card product-card">
      ${p.primary_image_id
        ? `<img src="${api.imageUrl(p.primary_image_id)}" alt="" onerror="this.outerHTML='<div class=&quot;pc-ph&quot;>\uD83D\uDCE6</div>'"/>`
        : `<div class="pc-ph">\uD83D\uDCE6</div>`}
      <div><div class="name">${p.product_name}</div>
        <div class="meta">${p.barcode ? "\uD83C\uDFF7\uFE0F " + p.barcode : p.product_code} \u00B7 Category: ${p.category_name || "\u2014"}</div>
        <div class="meta"><span class="stock ${stockCls}">${stockTxt}</span></div>
        <div class="meta"><span class="price">${money(p.selling_price)}</span>
          ${p.discount ? " \u00B7 \u2212" + money(p.discount) : ""}
          <span class="pill ${p.status === "active" ? "active" : "inactive"}">${p.status}</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn sm edit">Edit</button>
        <button class="btn sm toggle">${p.status === "active" ? "Disable" : "Enable"}</button>
      </div></div>`);
    card.querySelector(".edit").onclick = () => go("product", { id: p.id });
    card.querySelector(".toggle").onclick = async () => {
      await api.put("/api/products/" + p.id, {
        status: p.status === "active" ? "inactive" : "active",
      });
      reload();
    };
    return card;
  }

  // ---- Bulk import (Excel + images ZIP) ------------------------------------
  route("import", async () => {
    view.appendChild(topbar("Import products"));
    const s = screen();
    const box = el(`<div class="form-narrow">
      <div class="import-card">
        <div class="import-step"><b>1.</b> Download the template, fill it in Excel, then upload.</div>
        <button class="btn ghost dl-tpl" style="width:auto">\u2B07 Download template (.xlsx)</button>
        <div class="import-cols muted">Columns: product_name, category, price, quantity, barcode, min_stock, image_name</div>
      </div>
      <label class="dropzone" for="dz-file-input">
        <div class="dz-inner">\uD83D\uDCC4 <b>Tap to choose file</b><br/>.xlsx, .xls or .csv
          <div class="dz-file muted"></div></div>
        <input id="dz-file-input" class="dz-input" type="file"
               accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,*/*"/>
      </label>
      <div class="field"><label>Product images (.zip) \u2014 optional</label>
        <input class="input zip" type="file" accept=".zip"/>
        <div class="upload-hint">Image names must match the <b>image_name</b> column (or already be in uploads/products/).</div></div>
      <button class="btn primary run-import">Import products</button>
      <div class="msg import-msg"></div>
      <div class="import-summary" hidden></div>
      <div class="import-result"></div>
    </div>`);
    s.appendChild(box);
    view.appendChild(s);

    box.querySelector(".dl-tpl").onclick = () => window.open("/api/products/import/template", "_blank");
    const msg = box.querySelector(".import-msg");
    const summary = box.querySelector(".import-summary");
    const result = box.querySelector(".import-result");
    const dz = box.querySelector(".dropzone");
    const dzInput = box.querySelector(".dz-input");
    const dzFile = box.querySelector(".dz-file");
    let chosenFile = null;

    const setFile = (f) => { chosenFile = f; dzFile.textContent = f ? ("Selected: " + f.name) : ""; };
    // The <label for> opens the native picker (reliable in Android WebView).
    dzInput.onchange = () => setFile(dzInput.files[0]);
    ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
    dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });

    function downloadErrorReport(rows) {
      const failed = rows.filter((r) => r.status === "failed");
      if (!failed.length) return;
      const csv = "row,barcode,product_name,error\n" +
        failed.map((r) => `${r.row},"${r.barcode || ""}","${(r.product_name || "").replace(/"/g, '""')}","${(r.error || "").replace(/"/g, '""')}"`).join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = "import_errors.csv"; a.click();
      URL.revokeObjectURL(url);
    }

    box.querySelector(".run-import").onclick = async () => {
      msg.textContent = ""; msg.className = "msg import-msg"; result.innerHTML = ""; summary.hidden = true;
      if (!chosenFile) { msg.textContent = "Please choose a .xlsx or .csv file."; return; }
      const zip = box.querySelector(".zip").files[0];
      const btn = box.querySelector(".run-import");
      btn.disabled = true; btn.textContent = "Importing\u2026";
      try {
        const fd = new FormData();
        fd.append("file", chosenFile);
        if (zip) fd.append("images", zip);
        const r = await api.form("/api/products/import", fd);
        summary.hidden = false;
        summary.innerHTML = `
          <div class="sum-chip ok"><b>${r.created}</b> Imported</div>
          <div class="sum-chip upd"><b>${r.updated}</b> Updated</div>
          <div class="sum-chip skip"><b>${r.skipped}</b> Skipped</div>
          <div class="sum-chip fail"><b>${r.failed || 0}</b> Failed</div>`;
        globalToast(`Import complete \u00B7 ${r.created + r.updated} products`);
        if (r.failed) {
          const dl = el(`<button class="btn ghost sm" style="width:auto;margin-top:10px">\u2B07 Download error report</button>`);
          dl.onclick = () => downloadErrorReport(r.rows);
          summary.appendChild(dl);
        }
        result.innerHTML = (r.rows || []).map((row) => {
          const tag = row.status === "created" ? '<span class="pill active">created</span>'
            : row.status === "updated" ? '<span class="pill low">updated</span>'
            : row.status === "failed" ? '<span class="pill out">failed</span>'
            : '<span class="pill inactive">skipped</span>';
          const extra = row.error ? ` \u2014 ${row.error}` : (row.image ? ` \u00B7 image: ${row.image}` : "");
          return `<div class="ir-row"><span>${row.barcode || "\u2014"} ${row.product_name || ""}</span><span>${tag}${extra}</span></div>`;
        }).join("");
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        btn.disabled = false; btn.textContent = "Import products";
      }
    };
  });

  // ---- Replacement / Exchange ----------------------------------------------
  // Searchable product picker (name or barcode) backed by the products API.
  function productPicker(placeholder) {
    const box = el(`<div class="pp-wrap">
      <input class="input pp-input" type="text" inputmode="text" placeholder="${placeholder}"/>
      <div class="pp-list" hidden></div>
      <div class="pp-chosen" hidden></div>
    </div>`);
    const input = box.querySelector(".pp-input");
    const list = box.querySelector(".pp-list");
    const chosen = box.querySelector(".pp-chosen");
    box.value = null;   // selected product object
    let t;
    const clearChoice = () => {
      box.value = null; chosen.hidden = true; chosen.innerHTML = "";
      input.hidden = false;
    };
    input.oninput = () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (!q) { list.hidden = true; return; }
      t = setTimeout(async () => {
        try {
          const items = await api.get("/api/products?q=" + encodeURIComponent(q));
          list.innerHTML = "";
          if (!items.length) { list.hidden = true; return; }
          items.slice(0, 8).forEach((p) => {
            const row = el(`<button class="pp-item">
              <span class="pp-name">${p.product_name}</span>
              <span class="pp-meta">${p.barcode || ""} \u00B7 ${money(p.selling_price)} \u00B7 stock ${p.quantity}</span>
            </button>`);
            row.onclick = (e) => {
              e.preventDefault();
              box.value = p;
              chosen.innerHTML = `<div class="pp-picked"><b>${p.product_name}</b>
                <span class="muted sm">${money(p.selling_price)} \u00B7 stock ${p.quantity}</span>
                <button class="btn ghost sm pp-clear" style="width:auto">Change</button></div>`;
              chosen.hidden = false; input.hidden = true; list.hidden = true;
              chosen.querySelector(".pp-clear").onclick = (ev) => { ev.preventDefault(); clearChoice(); input.focus(); };
              box.dispatchEvent(new Event("change"));
            };
            list.appendChild(row);
          });
          list.hidden = false;
        } catch (_) { list.hidden = true; }
      }, 200);
    };
    return box;
  }

  route("replacement", async () => {
    view.appendChild(topbar("Replacement"));
    const s = screen();
    view.appendChild(s);

    const form = el(`<div class="form-narrow">
      <div class="card">
        <div class="rep-h">Customer (optional)</div>
        <div class="field"><label>Customer name</label><input class="input rp-name" type="text" placeholder="e.g. Rajesh"/></div>
        <div class="field"><label>Mobile number</label><input class="input rp-mobile" type="tel" inputmode="numeric" placeholder="e.g. 98765 43210"/></div>
        <div class="field"><label>Reason</label><input class="input rp-reason" type="text" placeholder="e.g. Damaged, wrong size"/></div>
      </div>
      <div class="card">
        <div class="rep-h">Returned product</div>
        <div class="src-toggle" data-slot="old">
          <button class="src-btn active" data-src="existing">Existing product</button>
          <button class="src-btn" data-src="manual">Manual entry</button>
        </div>
        <div class="rp-old src-existing" style="margin-top:10px"></div>
        <div class="src-manual" hidden style="margin-top:10px">
          <div class="field"><label>Product name</label><input class="input rp-oldmname" type="text" placeholder="e.g. Broken toy"/></div>
          <div class="field"><label>Product price</label><input class="input rp-oldmprice" type="number" inputmode="decimal" placeholder="0"/></div>
        </div>
        <div class="field"><label>Quantity</label><input class="input rp-oldqty" type="number" inputmode="numeric" value="1" min="1"/></div>
      </div>
      <div class="card rp-newcard">
        <div class="rep-h">Replacement product</div>
        <div class="src-toggle" data-slot="new">
          <button class="src-btn active" data-src="existing">Existing product</button>
          <button class="src-btn" data-src="manual">Manual entry</button>
        </div>
        <div class="rp-new src-existing" style="margin-top:10px"></div>
        <div class="src-manual" hidden style="margin-top:10px">
          <div class="field"><label>Product name</label><input class="input rp-newmname" type="text" placeholder="e.g. Custom hamper"/></div>
          <div class="field"><label>Product price</label><input class="input rp-newmprice" type="number" inputmode="decimal" placeholder="0"/></div>
        </div>
        <div class="field"><label>Quantity</label><input class="input rp-newqty" type="number" inputmode="numeric" value="1" min="1"/></div>
      </div>
      <div class="rp-refundtoggle" style="margin-bottom:12px">
        <button class="btn ghost rp-toggle" style="width:100%">\u21A9\uFE0F Refund Only \u2014 no replacement</button>
        <div class="muted sm" style="text-align:center;margin-top:6px">Customer returns a product and takes only the money back.</div>
      </div>
      <div class="card rp-refundcard" hidden>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="rep-h" style="margin:0">Refund method</div>
          <button class="btn ghost sm rp-cancelrefund" style="width:auto">\u2715 Cancel refund</button>
        </div>
        <div class="pay-grid" style="margin-top:10px">
          <button class="pay-opt rf-opt active" data-m="cash">\uD83D\uDCB5 Cash</button>
          <button class="pay-opt rf-opt" data-m="upi">\uD83D\uDCF1 UPI</button>
          <button class="pay-opt rf-opt" data-m="card">\uD83D\uDCB3 Card</button>
        </div>
        <div class="muted sm rf-hint" style="margin-top:8px">Cash refunds are deducted from the cash drawer. UPI/Card refunds are recorded only.</div>
      </div>
      <div class="card rp-calc">
        <div class="setting-row"><span class="k">Old product value</span><span class="v rp-oldval">\u20B90.00</span></div>
        <div class="setting-row rp-newrow"><span class="k">New product value</span><span class="v rp-newval">\u20B90.00</span></div>
        <div class="setting-row" style="border:none"><span class="k"><b class="rp-difflbl">Difference</b></span><span class="price rp-diff">\u20B90.00</span></div>
        <div class="rp-msg muted sm" style="margin-top:6px"></div>
      </div>
      <button class="btn primary rp-save">Complete replacement</button>
      <button class="btn ghost rp-hist" style="margin-top:8px">\uD83D\uDCDC Replacement history</button>
    </div>`);
    s.appendChild(form);

    let mode = "replacement";     // "replacement" | "refund"
    let refundMethod = "cash";

    const oldPick = productPicker("\uD83D\uDD0D Search returned product (name or barcode)");
    const newPick = productPicker("\uD83D\uDD0D Search replacement product (optional)");
    form.querySelector(".rp-old").appendChild(oldPick);
    form.querySelector(".rp-new").appendChild(newPick);

    // Source mode per slot: "existing" (DB picker) or "manual" (name+price).
    const src = { old: "existing", new: "existing" };
    form.querySelectorAll(".src-toggle").forEach((tg) => {
      const slot = tg.dataset.slot;
      const card = tg.closest(".card");
      tg.querySelectorAll(".src-btn").forEach((b) => {
        b.onclick = () => {
          tg.querySelectorAll(".src-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          src[slot] = b.dataset.src;
          card.querySelector(".src-existing").hidden = (src[slot] !== "existing");
          card.querySelector(".src-manual").hidden = (src[slot] !== "manual");
          recalc();
        };
      });
    });
    // Recalc when manual fields change.
    ["rp-oldmname", "rp-oldmprice", "rp-newmname", "rp-newmprice"].forEach((cls) => {
      form.querySelector("." + cls).oninput = () => recalc();
    });

    // Read a slot's current value regardless of source.
    const slotValue = (slot) => {
      if (src[slot] === "manual") {
        const nameEl = form.querySelector(slot === "old" ? ".rp-oldmname" : ".rp-newmname");
        const priceEl = form.querySelector(slot === "old" ? ".rp-oldmprice" : ".rp-newmprice");
        const name = nameEl.value.trim();
        const price = parseFloat(priceEl.value);
        if (!name || isNaN(price)) return null;
        return { manual: true, name, selling_price: price };
      }
      const pick = slot === "old" ? oldPick : newPick;
      return pick.value ? { manual: false, id: pick.value.id, name: pick.value.product_name, selling_price: pick.value.selling_price } : null;
    };

    const recalc = () => {
      const oq = Math.max(1, parseInt(form.querySelector(".rp-oldqty").value) || 1);
      const nq = Math.max(1, parseInt(form.querySelector(".rp-newqty").value) || 1);
      const oldItem = slotValue("old");
      const newItem = mode === "refund" ? null : slotValue("new");
      const oldVal = oldItem ? oldItem.selling_price * oq : 0;
      const isRefund = mode === "refund";
      const newVal = (!isRefund && newItem) ? newItem.selling_price * nq : 0;
      const diff = Math.round((newVal - oldVal) * 100) / 100;

      form.querySelector(".rp-oldval").textContent = money(oldVal);
      form.querySelector(".rp-newval").textContent = money(newVal);
      form.querySelector(".rp-newrow").hidden = isRefund;

      const dEl = form.querySelector(".rp-diff");
      const lbl = form.querySelector(".rp-difflbl");
      const msg = form.querySelector(".rp-msg");
      const refundCard = form.querySelector(".rp-refundcard");

      if (isRefund) {
        lbl.textContent = "Refund amount";
        dEl.textContent = money(oldVal);
        dEl.style.color = "#b91c1c";
        refundCard.hidden = !oldItem;
        msg.textContent = !oldItem ? "Choose or enter the returned product."
          : (refundMethod === "cash"
              ? `Refund ${money(oldVal)} in cash \u2014 deducted from the cash drawer.`
              : `Refund ${money(oldVal)} via ${refundMethod.toUpperCase()} \u2014 recorded only, cash drawer not affected.`);
      } else {
        lbl.textContent = "Difference";
        dEl.textContent = (diff > 0 ? "+" : "") + money(diff);
        dEl.style.color = diff > 0 ? "#b91c1c" : (diff < 0 ? "#15803d" : "");
        refundCard.hidden = !(diff < 0);
        if (!oldItem) msg.textContent = "Choose or enter the returned product to begin.";
        else if (diff > 0) msg.textContent = `Customer pays ${money(diff)}. A bill will be created.`;
        else if (diff < 0) msg.textContent = refundMethod === "cash"
          ? `Refund ${money(-diff)} in cash \u2014 deducted from the cash drawer.`
          : `Refund ${money(-diff)} via ${refundMethod.toUpperCase()} \u2014 cash drawer not affected.`;
        else if (newItem) msg.textContent = "Even exchange \u2014 nothing to pay.";
        else msg.textContent = "Choose or enter the replacement product.";
      }
      form.querySelector(".rp-save").textContent =
        isRefund ? "Complete refund" : "Complete replacement";
    };

    const setMode = (m) => {
      mode = m;
      const isRefund = m === "refund";
      // Refund Only hides the replacement product card; the toggle turns into
      // an active state, and a Cancel button (inside the refund card) returns.
      form.querySelector(".rp-newcard").hidden = isRefund;
      form.querySelector(".rp-refundtoggle").hidden = isRefund;
      const tgl = form.querySelector(".rp-toggle");
      tgl.classList.toggle("active", isRefund);
      if (isRefund) { newPick.value = null; }   // clear any replacement selection
      recalc();
    };

    // "Refund Only" toggle — reveals the refund flow on the same page.
    form.querySelector(".rp-toggle").onclick = () => setMode("refund");
    form.querySelector(".rp-cancelrefund").onclick = () => setMode("replacement");

    // Refund method selector.
    form.querySelectorAll(".rf-opt").forEach((b) => {
      b.onclick = () => {
        form.querySelectorAll(".rf-opt").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        refundMethod = b.dataset.m;
        recalc();
      };
    });

    oldPick.addEventListener("change", recalc);
    newPick.addEventListener("change", recalc);
    form.querySelector(".rp-oldqty").oninput = recalc;
    form.querySelector(".rp-newqty").oninput = recalc;
    recalc();

    form.querySelector(".rp-hist").onclick = () => go("replacements");
    form.querySelector(".rp-save").onclick = async () => {
      const isRefund = mode === "refund";
      const oldItem = slotValue("old");
      const newItem = isRefund ? null : slotValue("new");
      if (!oldItem) { alert("Please choose or enter the returned product."); return; }
      const oq = Math.max(1, parseInt(form.querySelector(".rp-oldqty").value) || 1);
      const nq = Math.max(1, parseInt(form.querySelector(".rp-newqty").value) || 1);
      const oldVal = oldItem.selling_price * oq;
      const newVal = newItem ? newItem.selling_price * nq : 0;
      const diff = Math.round((newVal - oldVal) * 100) / 100;

      if (!isRefund && !newItem) {
        alert("Choose or enter a replacement product, or switch to \u201CRefund Only\u201D.");
        return;
      }

      const body = {
        returned_qty: oq,
        customer_name: form.querySelector(".rp-name").value,
        mobile: form.querySelector(".rp-mobile").value,
        reason: form.querySelector(".rp-reason").value,
        refund_method: refundMethod,
      };
      // Returned item: existing or manual.
      if (oldItem.manual) { body.returned_manual_name = oldItem.name; body.returned_manual_price = oldItem.selling_price; }
      else { body.returned_product_id = oldItem.id; }
      // Replacement item (if not refund-only): existing or manual.
      if (!isRefund && newItem) {
        body.replacement_qty = nq;
        if (newItem.manual) { body.replacement_manual_name = newItem.name; body.replacement_manual_price = newItem.selling_price; }
        else { body.replacement_product_id = newItem.id; }
      }

      // Customer owes money -> ask how they're paying (same options as billing).
      if (!isRefund && diff > 0) {
        const pay = await new Promise((resolve) => {
          const m = el(`<div class="modal"><h3>Payment method</h3>
            <div class="sub">Customer pays ${money(diff)}</div>
            <div class="pay-grid">
              <button class="pay-opt" data-m="cash">\uD83D\uDCB5 Cash</button>
              <button class="pay-opt" data-m="upi">\uD83D\uDCF1 UPI</button>
              <button class="pay-opt" data-m="card">\uD83D\uDCB3 Card</button>
              <button class="pay-opt" data-m="split">\u2702\uFE0F Split</button>
            </div>
            <button class="btn ghost cancel" style="margin-top:10px">Cancel</button></div>`);
          const ref = modal(m);
          m.querySelectorAll(".pay-opt").forEach((b) => (b.onclick = () => { ref.resolve(); resolve(b.dataset.m); }));
          m.querySelector(".cancel").onclick = () => { ref.resolve(); resolve(null); };
        });
        if (!pay) return;
        body.payment_method = pay;
        if (pay === "split") {
          const split = await new Promise((resolve) => {
            const m = el(`<div class="modal"><h3>Split payment</h3>
              <div class="sub">Total: ${money(diff)}</div>
              <div class="field"><label>\uD83D\uDCB5 Cash</label><input class="input sp-cash" type="number" value="0"/></div>
              <div class="field"><label>\uD83D\uDCF1 UPI</label><input class="input sp-upi" type="number" value="0"/></div>
              <div class="field"><label>\uD83D\uDCB3 Card</label><input class="input sp-card" type="number" value="0"/></div>
              <div class="sp-remaining" style="font-weight:700;margin:8px 0"></div>
              <button class="btn primary sp-ok">Confirm</button>
              <button class="btn ghost sp-cancel" style="margin-top:8px">Cancel</button></div>`);
            const ref = modal(m);
            const get = (c) => parseFloat(m.querySelector(c).value) || 0;
            const upd = () => {
              const paid = get(".sp-cash") + get(".sp-upi") + get(".sp-card");
              const r = Math.round((diff - paid) * 100) / 100;
              const el2 = m.querySelector(".sp-remaining");
              el2.textContent = r === 0 ? "\u2713 Balanced" : (r > 0 ? `Remaining: ${money(r)}` : `Over by ${money(-r)}`);
              el2.style.color = r === 0 ? "#15803d" : "#b91c1c";
            };
            m.querySelectorAll("input").forEach((i) => (i.oninput = upd)); upd();
            m.querySelector(".sp-ok").onclick = () => {
              const parts = { cash: get(".sp-cash"), upi: get(".sp-upi"), card: get(".sp-card") };
              if (Math.round((parts.cash + parts.upi + parts.card) * 100) / 100 !== Math.round(diff * 100) / 100) {
                alert("Payment total does not match the amount due."); return;
              }
              ref.resolve(); resolve(parts);
            };
            m.querySelector(".sp-cancel").onclick = () => { ref.resolve(); resolve(null); };
          });
          if (!split) return;
          body.payment_split = split;
        }
      } else {
        // Refund (either mode): confirm, noting whether the drawer is touched.
        const amt = isRefund ? oldVal : -diff;
        if (amt > 0) {
          const where = refundMethod === "cash"
            ? "This will be deducted from the cash drawer."
            : `Recorded as a ${refundMethod.toUpperCase()} refund \u2014 the cash drawer is not affected.`;
          if (!confirm(`Refund ${money(amt)} to the customer?\n\n${where}`)) return;
        }
      }

      try {
        const r = await api.post("/api/replacements", body);
        const line = r.collected_amount > 0
          ? `Customer paid ${money(r.collected_amount)}`
          : (r.refund_amount > 0
              ? `Refunded ${money(r.refund_amount)} via ${(r.refund_method || "cash").toUpperCase()}`
              : "Even exchange");
        const m = el(`<div class="modal"><h3>${r.txn_type === "REFUND" ? "Refund" : "Replacement"} saved</h3>
          <div class="sub">${r.replacement_number} \u00B7 ${line}</div>
          <button class="btn primary rp-pdf">\uD83D\uDCC4 Print receipt</button>
          <button class="btn ghost rp-done" style="margin-top:8px">Done</button></div>`);
        const ref = modal(m);
        m.querySelector(".rp-pdf").onclick = () => window.open(`/api/replacements/${r.id}/pdf`, "_blank");
        m.querySelector(".rp-done").onclick = () => { ref.resolve(); go("replacement"); };
      } catch (e) { alert(e.message); }
    };
  });

  route("replacements", async () => {
    view.appendChild(topbar("Replacement history"));
    const s = screen();
    view.appendChild(s);
    const head = el(`<div class="searchbar">
      <input class="input rh-search" type="text" placeholder="\uD83D\uDD0D Search name, mobile, REP number or product"/>
      <div class="mode-toggle" style="margin-top:8px">
        <button class="mode-btn active" data-t="">All</button>
        <button class="mode-btn" data-t="REPLACEMENT">Replacement</button>
        <button class="mode-btn" data-t="REFUND">Refund</button>
      </div>
    </div>`);
    const listWrap = el(`<div class="list"></div>`);
    s.appendChild(head); s.appendChild(listWrap);
    let typeFilter = "";

    async function load() {
      const q = head.querySelector(".rh-search").value.trim();
      const qs = [];
      if (q) qs.push("q=" + encodeURIComponent(q));
      if (typeFilter) qs.push("type=" + typeFilter);
      const rows = await api.get("/api/replacements" + (qs.length ? "?" + qs.join("&") : ""));
      listWrap.innerHTML = "";
      if (!rows.length) { listWrap.appendChild(emptyBlock("\uD83D\uDD01", q || typeFilter ? "No matches." : "No replacements or refunds yet.")); return; }
      rows.forEach((r) => {
        const isRefund = r.txn_type === "REFUND";
        const settle = r.collected_amount > 0
          ? `<span style="color:#15803d">Collected ${money(r.collected_amount)}</span>`
          : (r.refund_amount > 0
              ? `<span style="color:#b91c1c">Refunded ${money(r.refund_amount)} \u00B7 ${(r.refund_method || "cash").toUpperCase()}</span>`
              : "Even exchange");
        const card = el(`<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="name">${r.replacement_number}
              <span class="pill" style="background:${isRefund ? "#b91c1c" : "var(--primary)"}">${isRefund ? "REFUND" : "REPLACEMENT"}</span>
            </div>
            <div>
              <button class="btn ghost sm rh-pdf" style="width:auto">\uD83D\uDCC4</button>
              <button class="btn ghost sm rh-del" style="width:auto;color:#b91c1c">\uD83D\uDDD1</button>
            </div>
          </div>
          <div class="meta">${r.date} ${r.time}${r.customer_name ? " \u00B7 " + r.customer_name : ""}${r.mobile ? " \u00B7 " + r.mobile : ""}</div>
          <div class="setting-row"><span class="k">Returned</span><span class="v">${r.returned_name}${r.returned_is_manual ? ' <span class="pill" style="background:#7c3aed">Manual</span>' : ""} \u00D7${r.returned_qty} \u00B7 ${money(r.old_amount)}</span></div>
          ${!isRefund ? `<div class="setting-row"><span class="k">Replacement</span><span class="v">${r.replacement_name}${r.replacement_is_manual ? ' <span class="pill" style="background:#7c3aed">Manual</span>' : ""} \u00D7${r.replacement_qty} \u00B7 ${money(r.new_amount)}</span></div>` : ""}
          <div class="setting-row" style="border:none"><span class="k">Settlement</span><span class="v">${settle}${r.payment_method ? " \u00B7 " + r.payment_method.toUpperCase() : ""}</span></div>
        </div>`);
        card.querySelector(".rh-pdf").onclick = () => window.open(`/api/replacements/${r.id}/pdf`, "_blank");
        card.querySelector(".rh-del").onclick = async () => {
          if (!confirm(`Delete ${r.replacement_number}?\n\nStock will be reversed. Bill History is NOT affected.`)) return;
          try { await api.del("/api/replacements/" + r.id); globalToast("Deleted"); load(); }
          catch (e) { alert(e.message); }
        };
        listWrap.appendChild(card);
      });
    }
    head.querySelectorAll(".mode-btn").forEach((b) => {
      b.onclick = () => {
        head.querySelectorAll(".mode-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        typeFilter = b.dataset.t;
        load();
      };
    });
    let t;
    head.querySelector(".rh-search").oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
    load();
  });

  // ---- Draft (held) bills ---------------------------------------------------
  route("drafts", async () => {
    view.appendChild(topbar("Draft bills"));
    const s = screen();
    view.appendChild(s);

    const head = el(`<div class="searchbar">
      <input class="input dr-search" type="text" inputmode="text" enterkeyhint="search"
        placeholder="\uD83D\uDD0D Search by customer name or draft number"/>
    </div>`);
    const listWrap = el(`<div class="list"></div>`);
    s.appendChild(head); s.appendChild(listWrap);

    async function load() {
      const q = head.querySelector(".dr-search").value.trim();
      const drafts = await api.get("/api/drafts" + (q ? "?q=" + encodeURIComponent(q) : ""));
      listWrap.innerHTML = "";
      if (!drafts.length) {
        listWrap.appendChild(emptyBlock("\uD83D\uDCCB", q ? "No drafts match that search." : "No held bills. Start a bill and tap \u201CHold & New\u201D to park it."));
        return;
      }
      drafts.forEach((d) => {
        const isCurrent = cart.draftId === d.id;
        const row = el(`<div class="card product-card draft-card" style="grid-template-columns:1fr auto auto;gap:10px;align-items:center">
          <div class="dr-open" style="cursor:pointer">
            <div class="name">${d.draft_number}${isCurrent ? ' <span class="pill">current</span>' : ""}</div>
            <div class="meta">${d.customer_name || "Walk-in"} \u00B7 ${d.item_count} item${d.item_count === 1 ? "" : "s"} \u00B7 ${d.updated_time}</div>
          </div>
          <div class="price">${money(d.total)}</div>
          <button class="btn ghost sm dr-del" title="Delete draft" style="width:auto;color:#b91c1c">\uD83D\uDDD1</button>
        </div>`);
        row.querySelector(".dr-open").onclick = async () => {
          // Current cart is already autosaved, so switching loses nothing.
          autosaveDraft(true);
          try {
            const full = await api.get("/api/drafts/" + d.id);
            cart.restore(full.payload, full.id, full.customer_name);
            go("scan");
          } catch (e) { alert(e.message); }
        };
        row.querySelector(".dr-del").onclick = async () => {
          if (!confirm(`Delete ${d.draft_number}${d.customer_name ? " (" + d.customer_name + ")" : ""}?\n\nThis does not affect Bill History.`)) return;
          try {
            await api.del("/api/drafts/" + d.id);
            if (cart.draftId === d.id) { cart.clear(); }
            globalToast("Draft deleted");
            updateDraftBadge();
            load();
          } catch (e) { alert(e.message); }
        };
        listWrap.appendChild(row);
      });
    }
    let t;
    head.querySelector(".dr-search").oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
    load();
  });

  // ---- Cash Drawer ---------------------------------------------------------
  route("cash", async () => {
    view.appendChild(topbar("Cash Drawer"));
    const s = screen();
    view.appendChild(s);
    const st = await api.get("/api/cash/status");

    const card = el(`<div class="card">
      <div class="rep-h">Today \u00B7 ${st.date}</div>
      <div class="setting-row"><span class="k">Opening Cash</span><span class="v" style="display:flex;gap:8px;align-items:center">${money(st.opening_cash)}<button class="btn ghost sm oc-edit" title="Edit opening cash" style="width:auto">\u270F\uFE0F Edit</button></span></div>
      <div class="setting-row"><span class="k">Today's CASH Sales</span><span class="v">${money(st.cash_sales)}</span></div>
      <div class="setting-row"><span class="k">Total Cash Expenses</span><span class="v">${money(st.cash_expenses)}</span></div>
      ${st.refunds > 0 ? `<div class="setting-row"><span class="k">Cash Refunds</span><span class="v" style="color:#b91c1c">-${money(st.refunds)}</span></div>` : ""}
      <div class="setting-row"><span class="k"><b>Expected in Drawer</b></span><span class="price">${money(st.expected_cash)}</span></div>
      ${st.actual_cash != null ? `<div class="setting-row"><span class="k">Actual Counted</span><span class="v">${money(st.actual_cash)}</span></div>
        <div class="setting-row" style="border:none"><span class="k">Difference</span><span class="v" style="color:${st.difference < 0 ? "#b91c1c" : "#15803d"}">${st.difference > 0 ? "+" : ""}${money(st.difference)}</span></div>` : ""}
    </div>`);
    s.appendChild(card);

    // Expenses list with Add / Edit / Delete.
    const expCard = el(`<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="rep-h" style="margin:0">Cash Expenses</div>
        <button class="btn primary sm exp-add" style="width:auto">+ Add Expense</button>
      </div>
      <div class="exp-list" style="margin-top:10px"></div>
    </div>`);
    s.appendChild(expCard);
    const renderExpenses = (list) => {
      const wrap = expCard.querySelector(".exp-list");
      if (!list.length) { wrap.innerHTML = `<div class="muted sm">No expenses added today.</div>`; return; }
      wrap.innerHTML = "";
      list.forEach((e) => {
        const row = el(`<div class="setting-row" style="align-items:center">
          <span class="k">${e.description}<div class="muted sm">${e.time || ""}</div></span>
          <span class="v" style="display:flex;gap:8px;align-items:center">
            ${money(e.amount)}
            <button class="btn ghost sm exp-edit" style="width:auto">\u270F\uFE0F</button>
            <button class="btn ghost sm exp-del" style="width:auto;color:#b91c1c">\uD83D\uDDD1</button>
          </span></div>`);
        row.querySelector(".exp-edit").onclick = () => expenseDialog(e);
        row.querySelector(".exp-del").onclick = async () => {
          if (!confirm(`Delete expense "${e.description}" (${money(e.amount)})?`)) return;
          try { await api.del("/api/cash/expenses/" + e.id); globalToast("Expense deleted"); render(); }
          catch (err) { alert(err.message); }
        };
        wrap.appendChild(row);
      });
      wrap.appendChild(el(`<div class="setting-row" style="border:none;margin-top:4px"><span class="k"><b>Total Expenses</b></span><span class="price">${money(list.reduce((t, e) => t + e.amount, 0))}</span></div>`));
    };
    renderExpenses(st.expenses || []);
    expCard.querySelector(".exp-add").onclick = () => expenseDialog(null);

    // Edit Opening Cash — modal with Save Changes / Cancel + confirmation.
    function editOpeningCashModal() {
      const m = el(`<div class="modal"><h3>Edit Opening Cash</h3>
        <div class="sub">${st.date}</div>
        <div class="setting-row"><span class="k">Current Opening Cash</span><span class="v">${money(st.opening_cash)}</span></div>
        <div class="field" style="margin-top:10px"><label>New Opening Cash (\u20B9)</label>
          <input class="input oc-amount" type="number" inputmode="decimal" value="${st.opening_cash}"/></div>
        <div class="muted sm" style="margin-bottom:10px">Only opening cash changes. Sales, expenses, refunds and all other records stay exactly as they are \u2014 the drawer rebalances automatically.</div>
        <button class="btn primary oc-save" style="margin-top:4px">Save Changes</button>
        <button class="btn ghost oc-cancel" style="margin-top:8px">Cancel</button></div>`);
      const ref = modal(m);
      m.querySelector(".oc-cancel").onclick = () => ref.resolve();
      m.querySelector(".oc-save").onclick = async () => {
        const n = parseFloat(m.querySelector(".oc-amount").value);
        if (isNaN(n) || n < 0) { alert("Enter a valid amount."); return; }
        if (!confirm(`Change opening cash from ${money(st.opening_cash)} to ${money(n)}?`)) return;
        try {
          const r = await api.post("/api/cash/edit-opening", { opening_cash: n });
          ref.resolve();
          globalToast(r.message || "Opening cash updated successfully");
          render();
        } catch (e) { alert(e.message); }
      };
    }
    card.querySelector(".oc-edit").onclick = () => editOpeningCashModal();

    const closeBtn = el(`<button class="btn primary" style="margin-bottom:8px">\uD83C\uDF19 Close Day (Count Cash)</button>`);
    closeBtn.onclick = () => openCloseDialog(st);
    s.appendChild(closeBtn);

    // History
    const hist = await api.get("/api/cash/history");
    if (hist.length) {
      s.appendChild(el(`<div class="rep-h" style="margin-top:18px">Cash History</div>`));
      hist.forEach((h) => {
        const diffColor = h.difference == null ? "" : (h.difference < 0 ? "#b91c1c" : "#15803d");
        s.appendChild(el(`<div class="card">
          <div class="setting-row"><span class="k"><b>${h.date}</b></span><span class="v">${h.closed ? "Closed" : "Open"}</span></div>
          <div class="setting-row"><span class="k">Opening</span><span class="v">${money(h.opening_cash)}</span></div>
          <div class="setting-row"><span class="k">Cash Sales</span><span class="v">${money(h.cash_sales)}</span></div>
          <div class="setting-row"><span class="k">Expenses</span><span class="v">${money(h.cash_expenses)}</span></div>
          ${(h.expenses && h.expenses.length) ? h.expenses.map((e) => `<div class="setting-row" style="padding-left:12px"><span class="k muted sm">\u2022 ${e.description}</span><span class="v sm">${money(e.amount)}</span></div>`).join("") : ""}
          ${h.refunds > 0 ? `<div class="setting-row"><span class="k">Cash Refunds</span><span class="v" style="color:#b91c1c">-${money(h.refunds)}</span></div>` : ""}
          <div class="setting-row"><span class="k">Expected</span><span class="v">${money(h.expected_cash)}</span></div>
          ${h.actual_cash != null ? `<div class="setting-row"><span class="k">Actual</span><span class="v">${money(h.actual_cash)}</span></div>
            <div class="setting-row"><span class="k">Difference</span><span class="v" style="color:${diffColor}">${h.difference > 0 ? "+" : ""}${money(h.difference)}</span></div>
            <div class="setting-row" style="border:none"><span class="k">Closing</span><span class="price">${money(h.closing_cash)}</span></div>` : ""}
        </div>`));
      });
    }
  });

  function expenseDialog(existing) {
    const isEdit = !!existing;
    const m = el(`<div class="modal"><h3>${isEdit ? "Edit" : "Add"} Expense</h3>
      <div class="field"><label>Expense Description</label>
        <input class="input ex-desc" type="text" placeholder="e.g. Tea & Snacks" value="${isEdit ? existing.description.replace(/"/g, "&quot;") : ""}"/></div>
      <div class="field"><label>Expense Amount</label>
        <input class="input ex-amt" type="number" inputmode="decimal" placeholder="0" value="${isEdit ? existing.amount : ""}"/></div>
      <button class="btn primary ex-save">Save Expense</button>
      <button class="btn ghost ex-cancel" style="margin-top:8px">Cancel</button></div>`);
    const ref = modal(m);
    m.querySelector(".ex-save").onclick = async () => {
      const desc = m.querySelector(".ex-desc").value.trim();
      const amt = parseFloat(m.querySelector(".ex-amt").value);
      if (!desc) { alert("Please enter a description."); return; }
      if (isNaN(amt) || amt < 0) { alert("Please enter a valid amount."); return; }
      try {
        if (isEdit) await api.post(`/api/cash/expenses/${existing.id}/edit`, { description: desc, amount: amt });
        else await api.post("/api/cash/expenses/add", { description: desc, amount: amt });
        ref.resolve(); globalToast("Expense saved"); render();
      } catch (e) { alert(e.message); }
    };
    m.querySelector(".ex-cancel").onclick = () => ref.resolve();
  }

  function openCloseDialog(st) {
    const m = el(`<div class="modal"><h3>\uD83C\uDF19 Close Day</h3>
      <div class="sub">${st.date}</div>
      <div class="setting-row"><span class="k">Today's Cash Sales</span><span class="v">${money(st.cash_sales)}</span></div>
      <div class="setting-row"><span class="k">Opening Cash</span><span class="v">${money(st.opening_cash)}</span></div>
      <div class="setting-row"><span class="k">Total Cash Expenses</span><span class="v">${money(st.cash_expenses)}</span></div>
      ${st.refunds > 0 ? `<div class="setting-row"><span class="k">Cash Refunds</span><span class="v" style="color:#b91c1c">-${money(st.refunds)}</span></div>` : ""}
      <div class="setting-row"><span class="k"><b>Expected in Drawer</b></span><span class="v">${money(st.expected_cash)}</span></div>
      <div class="field"><label>Actual Cash Counted</label><input class="input cl-actual" type="number" inputmode="decimal" placeholder="Count the drawer"/></div>
      <div class="cl-diff" style="font-weight:700;margin:6px 0"></div>
      <button class="btn primary cl-save">Save Closing</button>
      <button class="btn ghost cl-cancel" style="margin-top:8px">Cancel</button></div>`);
    const ref = modal(m);
    const recalc = () => {
      const actual = parseFloat(m.querySelector(".cl-actual").value);
      const diffEl = m.querySelector(".cl-diff");
      if (!isNaN(actual)) {
        const d = Math.round((actual - st.expected_cash) * 100) / 100;
        diffEl.textContent = `Difference: ${d > 0 ? "+" : ""}${money(d)}`;
        diffEl.style.color = d < 0 ? "#b91c1c" : "#15803d";
      } else { diffEl.textContent = ""; }
    };
    m.querySelector(".cl-actual").oninput = recalc;
    m.querySelector(".cl-save").onclick = async () => {
      const actual = parseFloat(m.querySelector(".cl-actual").value);
      if (isNaN(actual) || actual < 0) { alert("Enter the actual counted cash."); return; }
      try { await api.post("/api/cash/close", { cash_expenses: st.cash_expenses, actual_cash: actual }); ref.resolve(); globalToast("Day closed"); render(); }
      catch (e) { alert(e.message); }
    };
    m.querySelector(".cl-cancel").onclick = () => ref.resolve();
  }

  // ---- Reports (Daily / Monthly / Custom, PDF + Excel) ---------------------
  route("reports", async () => {
    view.appendChild(topbar("Reports"));
    const s = screen();
    const today = new Date().toISOString().slice(0, 10);
    const yr = new Date().getFullYear();
    const mo = new Date().getMonth() + 1;
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const box = el(`<div class="form-narrow">
      <div class="rep-tabs">
        <button class="rep-tab active" data-t="daily">Daily</button>
        <button class="rep-tab" data-t="monthly">Monthly</button>
        <button class="rep-tab" data-t="custom">Custom Range</button>
      </div>
      <div class="card rep-panel">
        <div class="rep-fields"></div>
        <details class="rep-filters">
          <summary>\uD83D\uDD0D Advanced filters</summary>
          <div class="field"><label>Category</label>
            <select class="input f-cat"><option value="">All categories</option></select></div>
          <div class="field"><label>Product name contains</label>
            <input class="input f-prod" type="text" placeholder="e.g. Notebook"/></div>
          <div class="field"><label>Bill number contains</label>
            <input class="input f-bill" type="text" placeholder="e.g. BILL-0001"/></div>
          <div class="rep-minmax">
            <div class="field"><label>Min amount</label><input class="input f-min" type="number" inputmode="decimal" placeholder="0"/></div>
            <div class="field"><label>Max amount</label><input class="input f-max" type="number" inputmode="decimal" placeholder="\u221e"/></div>
          </div>
          <button class="btn ghost sm f-clear" style="width:auto">Clear filters</button>
        </details>
        <div class="rep-actions">
          <button class="btn ghost rep-view">\uD83D\uDC41 View Report</button>
          <button class="btn primary rep-pdf">\u2B07 PDF</button>
          <button class="btn primary rep-xls">\u2B07 Excel</button>
        </div>
        <div class="msg rep-msg"></div>
      </div>
      <div class="rep-output"></div>
    </div>`);
    s.appendChild(box); view.appendChild(s);

    let kind = "daily";
    const fields = box.querySelector(".rep-fields");
    const out = box.querySelector(".rep-output");

    function renderFields() {
      if (kind === "daily") {
        fields.innerHTML = `<div class="field"><label>Date</label>
          <input class="input f-date" type="date" value="${today}" max="${today}"/></div>`;
      } else if (kind === "monthly") {
        const opts = months.map((m, i) => `<option value="${i + 1}" ${i + 1 === mo ? "selected" : ""}>${m}</option>`).join("");
        const years = [yr, yr - 1, yr - 2].map((y) => `<option value="${y}">${y}</option>`).join("");
        fields.innerHTML = `<div class="field"><label>Month</label><select class="input f-month">${opts}</select></div>
          <div class="field"><label>Year</label><select class="input f-year">${years}</select></div>`;
      } else {
        fields.innerHTML = `<div class="field"><label>From</label><input class="input f-from" type="date" value="${today}" max="${today}"/></div>
          <div class="field"><label>To</label><input class="input f-to" type="date" value="${today}" max="${today}"/></div>`;
      }
    }
    function query() {
      const p = new URLSearchParams({ type: kind });
      if (kind === "daily") p.set("date", box.querySelector(".f-date").value);
      else if (kind === "monthly") { p.set("year", box.querySelector(".f-year").value); p.set("month", box.querySelector(".f-month").value); }
      else { p.set("from", box.querySelector(".f-from").value); p.set("to", box.querySelector(".f-to").value); }
      // Advanced filters (all optional).
      const cat = box.querySelector(".f-cat").value;
      const prod = box.querySelector(".f-prod").value.trim();
      const bill = box.querySelector(".f-bill").value.trim();
      const min = box.querySelector(".f-min").value;
      const max = box.querySelector(".f-max").value;
      if (cat) p.set("category_id", cat);
      if (prod) p.set("product", prod);
      if (bill) p.set("bill_number", bill);
      if (min !== "") p.set("min_amount", min);
      if (max !== "") p.set("max_amount", max);
      return p.toString();
    }
    // Populate categories in the filter dropdown.
    (async () => {
      try {
        const cats = await api.get("/api/categories");
        const sel = box.querySelector(".f-cat");
        cats.forEach((c) => {
          const o = document.createElement("option");
          o.value = c.id; o.textContent = c.category_name;
          sel.appendChild(o);
        });
      } catch (_) {}
    })();
    box.querySelector(".f-clear").onclick = (e) => {
      e.preventDefault();
      box.querySelector(".f-cat").value = "";
      box.querySelector(".f-prod").value = "";
      box.querySelector(".f-bill").value = "";
      box.querySelector(".f-min").value = "";
      box.querySelector(".f-max").value = "";
    };
    box.querySelectorAll(".rep-tab").forEach((t) => {
      t.onclick = () => {
        box.querySelectorAll(".rep-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active"); kind = t.dataset.t; renderFields(); out.innerHTML = "";
      };
    });
    box.querySelector(".rep-pdf").onclick = () => window.open("/api/reports/pdf?" + query(), "_blank");
    box.querySelector(".rep-xls").onclick = () => window.open("/api/reports/excel?" + query(), "_blank");
    box.querySelector(".rep-view").onclick = async () => {
      out.innerHTML = `<div class="muted" style="padding:14px">Loading\u2026</div>`;
      try {
        const r = await api.get("/api/reports/view?" + query());
        out.innerHTML = `
          <div class="card">
            <div class="rep-h">${r.report_type}</div><div class="muted sm">${r.period}</div>
            <div class="rep-sum">
              <div><span>Total Bills</span><b>${r.total_bills}</b></div>
              <div><span>Items Sold</span><b>${r.total_items}</b></div>
              <div><span>Gross</span><b>${money(r.gross)}</b></div>
              <div><span>Discount</span><b>${money(r.discount)}</b></div>
              <div><span>Net Sales</span><b>${money(r.net)}</b></div>
              ${r.manual_sales_total ? `<div><span>Manual Entry</span><b style="color:#7c3aed">${money(r.manual_sales_total)}</b></div>` : ""}
              <div><span>Overall Sales</span><b class="net">${money(r.overall_sales != null ? r.overall_sales : r.net)}</b></div>
            </div>
          </div>
          ${manualSectionHtml(r)}
          ${kind === "monthly" ? '<div class="card daywise-card"><div class="rep-h">Day Wise Sales</div><div class="daywise-list"><div class="muted sm">Loading days\u2026</div></div></div>' : ""}
          ${(r.top_categories && r.top_categories.length) ? `<div class="card"><div class="rep-h">Top Selling Categories</div>
            ${r.top_categories.map((cat, i) => `
              <div class="cat-row" data-cat="${i}">
                <div class="cat-head">
                  <span class="cat-rank">#${i + 1}</span>
                  <span class="cat-name">${cat.name}</span>
                  <span class="cat-rev">${money(cat.revenue)}</span>
                  <span class="cat-caret">\u25BC</span>
                </div>
                <div class="cat-sub">Products sold: ${cat.qty} \u00B7 ${cat.percent}% of sales</div>
                <div class="cat-bar"><div class="cat-bar-fill" style="width:${Math.max(2, cat.percent)}%"></div></div>
                <div class="cat-products" hidden>
                  ${cat.products.map((p, j) => `<div class="rep-row" style="padding-left:12px"><span>${j + 1}. ${p.name}</span><span>Qty ${p.qty} \u00B7 ${money(p.revenue)}</span></div>`).join("")}
                </div>
              </div>`).join("")}
          </div>` : ""}
          ${r.top_products.length ? `<div class="card"><div class="rep-h">Top Products</div>
            ${r.top_products.map((p) => `<div class="rep-row"><span>${p.name}</span><span>${p.qty} \u00B7 ${money(p.revenue)}</span></div>`).join("")}</div>` : ""}
          <div class="card"><div class="rep-h">Payment Summary</div>
            <div class="rep-row"><span>\uD83D\uDCB5 Cash</span><span>${money((r.payment && r.payment.cash) || 0)}</span></div>
            <div class="rep-row"><span>\uD83D\uDCF1 UPI</span><span>${money((r.payment && r.payment.upi) || 0)}</span></div>
            <div class="rep-row"><span>\uD83D\uDCB3 Card</span><span>${money((r.payment && r.payment.card) || 0)}</span></div>
            <div class="rep-row"><span><b>Online (UPI+Card)</b></span><span><b>${money(r.online_sales || 0)}</b></span></div>
            <div class="rep-row"><span><b>Cash</b></span><span><b>${money(r.cash_sales || 0)}</b></span></div>
          </div>
          ${r.bills.length ? `<div class="card"><div class="rep-h">Bills (${r.bills.length})</div>
            ${r.bills.map((b) => `<div class="rep-row"><span>${b.bill_number} \u00B7 ${b.time}</span><span>${b.items} items \u00B7 ${money(b.amount)}</span></div>`).join("")}</div>` : `<div class="empty">No bills in this period.</div>`}`;
        // Clicking a category row expands its product breakdown.
        out.querySelectorAll(".cat-row").forEach((row) => {
          row.querySelector(".cat-head").onclick = () => {
            const prods = row.querySelector(".cat-products");
            prods.hidden = !prods.hidden;
            row.classList.toggle("open", !prods.hidden);
          };
        });
        wireManualSection(r);
        if (kind === "monthly") loadDayWise();
      } catch (e) { out.innerHTML = `<div class="msg">${e.message}</div>`; }
    };

    // ---- Day Wise Sales (monthly reports) ----
    async function loadDayWise() {
      const wrap = out.querySelector(".daywise-list");
      if (!wrap) return;
      const year = box.querySelector(".f-year").value;
      const month = box.querySelector(".f-month").value;
      try {
        const days = await api.get(`/api/reports/day-wise?year=${year}&month=${month}`);
        wrap.innerHTML = "";
        days.forEach((d) => {
          const row = el(`<div class="dw-row">
            <div class="dw-head" style="cursor:pointer">
              <div class="dw-date">${d.label} <span class="dw-caret muted" style="font-size:11px">\u25BC</span></div>
              <div class="dw-nums">
                ${d.num_bills ? `<span>Bills: ${d.num_bills}</span> \u00B7 <span>${money(d.net)}</span>` : ""}
                ${d.manual_amount ? `${d.num_bills ? " \u00B7 " : ""}<span style="color:#7c3aed">Manual: ${money(d.manual_amount)}</span>` : ""}
                ${!d.has_data ? '<span class="muted">No sales recorded</span>' : ""}
              </div>
              ${d.has_data ? `<div class="dw-total price">${money(d.total)}</div>` : ""}
            </div>
            <div class="dw-body" hidden></div>
          </div>`);
          const body = row.querySelector(".dw-body");
          let loaded = false;
          row.querySelector(".dw-head").onclick = async () => {
            body.hidden = !body.hidden;
            row.querySelector(".dw-caret").style.transform = body.hidden ? "" : "rotate(180deg)";
            if (body.hidden || loaded) return;
            if (!d.has_data) { body.innerHTML = `<div class="muted sm" style="padding:8px">No sales recorded.</div>`; loaded = true; return; }
            body.innerHTML = `<div class="muted sm" style="padding:8px">Loading\u2026</div>`;
            // Manual-only day: show the manual entry details.
            let html = "";
            if (d.manual) {
              html += `<div class="card" style="margin:6px 0;padding:10px;background:#faf5ff">
                <div><b>Manual Entry</b></div>
                <div class="setting-row"><span class="k">Amount</span><span class="v">${money(d.manual.amount)}</span></div>
                ${d.manual.note ? `<div class="setting-row"><span class="k">Reason</span><span class="v">${d.manual.note}</span></div>` : ""}
                <div class="setting-row"><span class="k">Created by</span><span class="v">${d.manual.created_by || "\u2014"}</span></div>
                <div class="setting-row" style="border:none"><span class="k">Created</span><span class="v">${d.manual.created_at_date} ${d.manual.created_at_time}</span></div>
              </div>`;
            }
            // Bills for the day (lazy-loaded).
            if (d.num_bills) {
              try {
                const res = await api.get(`/api/bills?from=${d.date}&to=${d.date}&limit=500`);
                const bills = res.items || [];
                bills.forEach((b) => {
                  const bc = el(`<div class="card" style="margin:6px 0;padding:10px">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                      <div><b>${b.bill_number}</b> <span class="muted sm">${b.time_ist || ""}</span></div>
                      <div class="price">${money(b.grand_total)}</div>
                    </div>
                    <div class="muted sm">${b.total_items} items \u00B7 ${(b.payment_method || "cash").toUpperCase()}</div>
                    <div class="btn-row" style="margin-top:8px;gap:6px">
                      <button class="btn ghost sm dw-view" style="width:auto">\uD83D\uDC41 View</button>
                      <button class="btn ghost sm dw-print" style="width:auto">\uD83D\uDDA8 Print</button>
                      <button class="btn ghost sm dw-edit" style="width:auto">\u270F\uFE0F Payment</button>
                    </div></div>`);
                  bc.querySelector(".dw-view").onclick = () => go("bill", { id: b.id });
                  bc.querySelector(".dw-print").onclick = () => { go("bill", { id: b.id }); setTimeout(() => window.print(), 600); };
                  bc.querySelector(".dw-edit").onclick = () => editBillPayment(b, () => box.querySelector(".rep-view").click());
                  body.appendChild(bc);
                });
                // Remove the "Loading…" once bills are in (keep manual html on top).
                body.querySelector(".muted.sm")?.remove();
                if (html) body.insertAdjacentHTML("afterbegin", html);
              } catch (e) { body.innerHTML = `<div class="msg">${e.message}</div>`; }
            } else {
              body.innerHTML = html;
            }
            loaded = true;
          };
          wrap.appendChild(row);
        });
      } catch (e) { wrap.innerHTML = `<div class="msg">${e.message}</div>`; }
    }

    // ---- Manual Daily Sales Entry (only for a single-day report) ----
    function manualSectionHtml(r) {
      if (kind !== "daily") return "";   // manual entry is per-date
      const existing = (r.manual_sales || []).find((m) => true);
      const amt = existing ? existing.amount : "";
      const showByDefault = r.total_bills === 0 || !!existing;
      return `<div class="card manual-sec"${showByDefault ? "" : ' data-collapsed="1"'}>
        <div class="rep-h">Manual Daily Sales Entry</div>
        <div class="muted sm" style="margin-bottom:8px">Use this when the billing system was down. It adds to revenue reports only \u2014 no bills, no stock changes.</div>
        ${existing ? `<div class="ms-saved" style="margin-bottom:8px">
          <div class="setting-row"><span class="k">Overall Sales</span><span class="price">${money(existing.amount)}</span></div>
          <div class="muted sm">(Source: Manual Entry \u00B7 saved ${existing.created_at_date} ${existing.created_at_time}${existing.updated_at_time !== existing.created_at_time ? ", edited " + existing.updated_at_time : ""})</div>
        </div>` : ""}
        <div class="field"><label>Overall Sales Amount (\u20B9)</label><input class="input ms-amount" type="number" inputmode="decimal" placeholder="0" value="${amt}"/></div>
        <div class="btn-row" style="gap:8px">
          <button class="btn primary sm ms-save" style="width:auto">${existing ? "Update" : "Save"} Manual Entry</button>
          ${existing ? '<button class="btn ghost sm ms-del" style="width:auto;color:#b91c1c">Delete</button>' : ""}
        </div>
      </div>`;
    }
    function wireManualSection(r) {
      const sec = out.querySelector(".manual-sec");
      if (!sec) return;
      const date = box.querySelector(".f-date").value;
      sec.querySelector(".ms-save").onclick = async () => {
        const amount = parseFloat(sec.querySelector(".ms-amount").value);
        if (isNaN(amount) || amount < 0) { alert("Enter a valid amount."); return; }
        if (!confirm(`Save manual sales of ${money(amount)} for ${date}?`)) return;
        try {
          await api.post("/api/sales/manual", { date, amount });
          globalToast("Manual entry saved");
          box.querySelector(".rep-view").click();   // refresh report
        } catch (e) { alert(e.message); }
      };
      const del = sec.querySelector(".ms-del");
      if (del) del.onclick = async () => {
        if (!confirm(`Delete the manual sales entry for ${date}?`)) return;
        try {
          await api.del("/api/sales/manual/" + date);
          globalToast("Manual entry deleted");
          box.querySelector(".rep-view").click();
        } catch (e) { alert(e.message); }
      };
    }
    renderFields();
  });

  // ---- Product form (add / edit) -------------------------------------------
  route("product", async (params) => {
    const editing = !!params.id;
    view.appendChild(topbar(editing ? "Edit product" : "Add product"));
    const s = screen();
    const cats = await api.get("/api/categories");
    let product = null;
    if (editing) {
      const all = await api.get("/api/products");
      product = all.find((p) => String(p.id) === String(params.id));
    }

    const form = el(`<div class="form-narrow">
      <div class="field"><label>Product name</label>
        <input class="input" name="name" value="${product ? product.product_name : ""}"/></div>
      <div class="field"><label>Category</label>
        <select class="input" name="category_id"></select></div>
      <div class="btn-row">
        <div class="field" style="flex:1"><label>Selling price</label>
          <input class="input" name="selling_price" type="number" inputmode="decimal" value="${product ? product.selling_price : ""}"/></div>
        <div class="field" style="flex:1"><label>Cost price</label>
          <input class="input" name="cost_price" type="number" inputmode="decimal" value="${product ? product.cost_price : "0"}"/></div>
      </div>
      <div class="btn-row">
        <div class="field" style="flex:1"><label>Discount</label>
          <input class="input" name="discount" type="number" inputmode="decimal" value="${product ? product.discount : "0"}"/></div>
        <div class="field" style="flex:1"><label>${editing ? "Stock quantity" : "Opening stock"}</label>
          <input class="input" name="quantity" type="number" inputmode="numeric" value="${product ? product.quantity : "0"}"/></div>
        <div class="field" style="flex:1"><label>Min stock level</label>
          <input class="input" name="min_stock_level" type="number" inputmode="numeric" value="${product ? product.min_stock_level : "0"}"/></div>
      </div>
      <div class="field"><label>Description (optional)</label>
        <input class="input" name="description" value="${product && product.description ? product.description : ""}"/></div>
      <div class="field"><label>Barcode</label>
        <div class="btn-row" style="gap:8px">
          <input class="input" name="barcode" value="${product && product.barcode ? product.barcode : ""}" placeholder="Auto-generated" style="flex:1"/>
          <button type="button" class="btn ghost sm gen-bc" style="width:auto;white-space:nowrap">Generate</button>
          ${editing && product && product.barcode ? '<button type="button" class="btn primary sm print-bc" style="width:auto;white-space:nowrap">Print label</button>' : ""}
        </div></div>
      <div class="field"><label>Size family (optional — share across sizes of the same item)</label>
        <input class="input" name="family_key" value="${product && product.family_key ? product.family_key : ""}"/></div>
      ${editing ? "" : `<div class="field upload-field"><label>Product image (optional)</label>
        <div class="upload-hint">A photo helps confirm the item at billing. Optional — up to <b class="max-n">10</b>.</div>
        <input class="file-real" name="images" type="file" accept="image/*" multiple hidden/>
        <div class="upload-actions">
          <button type="button" class="btn ghost pick-files" style="width:auto">\uD83D\uDDBC\uFE0F Choose images</button>
          <span class="upload-count muted">No images selected</span>
        </div>
        <div class="preview-grid"></div></div>`}
      <button class="btn primary save">${editing ? "Save changes" : "Save product"}</button>
      ${editing ? '<button class="btn danger" style="margin-top:10px">Delete product</button>' : ""}
      <div class="msg" style="color:var(--danger);margin-top:12px"></div>
    </div>`);
    s.appendChild(form);
    view.appendChild(s);

    const sel = form.querySelector('[name="category_id"]');
    cats.forEach((c) => {
      const o = el(`<option value="${c.id}">${c.category_name}</option>`);
      if (product && product.category_id === c.id) o.selected = true;
      sel.appendChild(o);
    });
    const msg = form.querySelector(".msg");

    // ---- Barcode: prefill next, generate, print label ----------------------
    const bcField = form.querySelector('[name="barcode"]');
    if (!editing && bcField && !bcField.value) {
      try { const r = await api.get("/api/products/next-barcode"); bcField.value = r.barcode; } catch (_) {}
    }
    const genBtn = form.querySelector(".gen-bc");
    if (genBtn) genBtn.onclick = async () => {
      try { const r = await api.get("/api/products/next-barcode"); bcField.value = r.barcode; }
      catch (e) { msg.textContent = e.message; }
    };
    const printBtn = form.querySelector(".print-bc");
    if (printBtn) printBtn.onclick = () => window.open("/api/products/" + product.id + "/label", "_blank");

    // ---- Image picker (optional in the barcode flow) -----------------------
    let MIN_IMG = 0, MAX_IMG = 10;
    const selected = []; // managed list of File objects
    if (!editing) {
      try {
        const info = await api.get("/api/settings/info");
        MAX_IMG = info.max_product_images || 10;
        form.querySelector(".max-n").textContent = MAX_IMG;
      } catch (_) {}
      const fileInput = form.querySelector(".file-real");
      const grid = form.querySelector(".preview-grid");
      const countEl = form.querySelector(".upload-count");

      const renderPreviews = () => {
        grid.innerHTML = "";
        selected.forEach((file, i) => {
          const url = URL.createObjectURL(file);
          const cell = el(`<div class="preview-cell">
            <img src="${url}" alt=""/>
            <button type="button" class="preview-rm" title="Remove">\u00D7</button></div>`);
          cell.querySelector("img").onload = () => URL.revokeObjectURL(url);
          cell.querySelector(".preview-rm").onclick = () => { selected.splice(i, 1); renderPreviews(); };
          grid.appendChild(cell);
        });
        const n = selected.length;
        countEl.textContent = n === 0 ? "No images selected"
          : `${n} image${n === 1 ? "" : "s"} selected` + (n < MIN_IMG ? ` — need at least ${MIN_IMG}` : "");
        countEl.classList.toggle("warn", n > 0 && n < MIN_IMG);
        countEl.classList.toggle("ok", n >= MIN_IMG && n <= MAX_IMG);
      };

      form.querySelector(".pick-files").onclick = () => fileInput.click();
      fileInput.onchange = () => {
        for (const f of fileInput.files) {
          if (!f.type.startsWith("image/")) continue;
          if (selected.some((x) => x.name === f.name && x.size === f.size)) continue; // dedupe
          if (selected.length >= MAX_IMG) { msg.textContent = `You can upload at most ${MAX_IMG} images.`; break; }
          selected.push(f);
        }
        fileInput.value = ""; // allow re-picking the same file later
        renderPreviews();
      };
      renderPreviews();
    }

    form.querySelector(".save").onclick = async () => {
      msg.textContent = "";
      try {
        if (editing) {
          await api.put("/api/products/" + product.id, {
            product_name: form.querySelector('[name="name"]').value,
            category_id: Number(sel.value),
            selling_price: form.querySelector('[name="selling_price"]').value,
            cost_price: form.querySelector('[name="cost_price"]').value,
            discount: form.querySelector('[name="discount"]').value,
            quantity: form.querySelector('[name="quantity"]').value,
            min_stock_level: form.querySelector('[name="min_stock_level"]').value,
            description: form.querySelector('[name="description"]').value,
            barcode: form.querySelector('[name="barcode"]').value,
            family_key: form.querySelector('[name="family_key"]').value,
          });
        } else {
          if (selected.length > MAX_IMG) {
            msg.textContent = `You can upload at most ${MAX_IMG} product images.`;
            return;
          }
          const fd = new FormData();
          fd.append("name", form.querySelector('[name="name"]').value);
          fd.append("category_id", sel.value);
          fd.append("selling_price", form.querySelector('[name="selling_price"]').value);
          fd.append("cost_price", form.querySelector('[name="cost_price"]').value);
          fd.append("discount", form.querySelector('[name="discount"]').value);
          fd.append("quantity", form.querySelector('[name="quantity"]').value);
          fd.append("min_stock_level", form.querySelector('[name="min_stock_level"]').value);
          fd.append("description", form.querySelector('[name="description"]').value);
          fd.append("barcode", form.querySelector('[name="barcode"]').value);
          fd.append("family_key", form.querySelector('[name="family_key"]').value);
          selected.forEach((f) => fd.append("images", f));
          await api.form("/api/products", fd);
        }
        go("products");
      } catch (e) {
        msg.textContent = e.message;
      }
    };

    if (editing) {
      form.querySelector(".danger").onclick = async () => {
        if (!confirm("Delete this product? This action cannot be undone.")) return;
        await api.del("/api/products/" + product.id);
        go("products");
      };
    }
  });

  // ---- Inventory ------------------------------------------------------------
  route("inventory", async () => {
    view.appendChild(topbar("Inventory"));
    const s = screen();
    const head = el(`<div class="searchbar">
      <div class="btn-row">
        <div class="seg">
          <button class="seg-btn active" data-f="all">All stock</button>
          <button class="seg-btn" data-f="low">Low / out</button>
        </div>
        <button class="btn ghost sm hist" style="width:auto;white-space:nowrap">History</button>
      </div></div>`);
    const list = el(`<div class="list inv-list"></div>`);
    s.appendChild(head);
    s.appendChild(list);
    view.appendChild(s);

    let filter = "all";
    async function load() {
      list.innerHTML = `<div class="muted" style="padding:14px">Loading…</div>`;
      const rows = await api.get("/api/inventory" + (filter === "low" ? "?low=1" : ""));
      list.innerHTML = "";
      if (!rows.length) { list.appendChild(emptyBlock("\uD83D\uDCCA", "Nothing to show here.")); return; }
      rows.forEach((p) => {
        const badge = p.stock_status === "out" ? `<span class="pill out">Out of stock</span>`
          : p.stock_status === "low" ? `<span class="pill low">Low stock</span>`
          : `<span class="pill active">In stock</span>`;
        const row = el(`<div class="card inv-row">
          <div class="inv-main">
            <div class="name">${p.product_name}</div>
            <div class="muted sm">${p.product_code} \u00B7 min ${p.min_stock_level}</div>
            ${badge}
          </div>
          <div class="inv-qty"><span class="q">${p.quantity}</span><span class="muted sm">in stock</span></div>
          <div class="inv-acts">
            <button class="btn sm primary in">Stock in</button>
            <button class="btn sm ghost adj">Adjust</button>
          </div></div>`);
        row.querySelector(".in").onclick = () => stockMove(p, "in", load);
        row.querySelector(".adj").onclick = () => stockMove(p, "adjust", load);
        list.appendChild(row);
      });
    }
    head.querySelectorAll(".seg-btn").forEach((b) => (b.onclick = () => {
      head.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active"); filter = b.dataset.f; load();
    }));
    head.querySelector(".hist").onclick = () => showHistory();
    load();
  });

  async function stockMove(product, kind, after) {
    const isIn = kind === "in";
    const m = el(`<div class="modal"><h3>${isIn ? "Stock in" : "Adjust stock"}</h3>
      <div class="sub">${product.product_name} \u00B7 currently ${product.quantity}</div>
      <div class="field" style="margin-top:10px"><label>${isIn ? "Quantity to add" : "Change (+ add / − remove)"}</label>
        <input class="input qty" type="number" inputmode="numeric" value="${isIn ? "1" : "-1"}"/></div>
      <div class="field"><label>Remarks</label>
        <input class="input rmk" placeholder="${isIn ? "Purchase, restock…" : "Damaged, returned, correction…"}"/></div>
      <button class="btn primary go">${isIn ? "Add stock" : "Apply adjustment"}</button>
      <button class="btn ghost cancel" style="margin-top:8px">Cancel</button>
      <div class="msg" style="color:var(--danger);margin-top:10px"></div></div>`);
    const ref = modal(m);
    m.querySelector(".cancel").onclick = () => ref.resolve();
    m.querySelector(".go").onclick = async () => {
      const v = Number(m.querySelector(".qty").value);
      const remarks = m.querySelector(".rmk").value;
      try {
        if (isIn) await api.post("/api/inventory/stock-in", { product_id: product.id, quantity: v, remarks });
        else await api.post("/api/inventory/adjust", { product_id: product.id, delta: v, remarks });
        ref.resolve(); after && after();
      } catch (e) { m.querySelector(".msg").textContent = e.message; }
    };
  }

  async function showHistory() {
    const rows = await api.get("/api/inventory/history");
    const m = el(`<div class="modal wide"><h3>Stock history</h3>
      <div class="hist-list"></div>
      <button class="btn primary" style="margin-top:12px">Close</button></div>`);
    const hl = m.querySelector(".hist-list");
    if (!rows.length) hl.innerHTML = `<div class="muted" style="padding:12px">No movements yet.</div>`;
    rows.forEach((h) => {
      const sign = h.quantity > 0 ? "+" : "";
      const cls = h.type === "in" ? "in" : h.type === "out" ? "out" : "adj";
      hl.appendChild(el(`<div class="hist-row">
        <div><div class="name">${h.product_name}</div><div class="muted sm">${new Date(h.date).toLocaleString()} \u00B7 ${h.remarks || ""}</div></div>
        <div class="hist-q ${cls}">${sign}${h.quantity}<span class="muted sm">\u2192 ${h.balance_after}</span></div></div>`));
    });
    const ref = modal(m);
    m.querySelector("button").onclick = () => ref.resolve();
  }

  // ---- Categories -----------------------------------------------------------
  route("categories", async () => {
    view.appendChild(topbar("Categories"));
    const s = screen();
    const add = el(`<div class="btn-row" style="margin-bottom:14px">
      <input class="input" placeholder="New category name"/>
      <button class="btn primary sm" style="width:auto">Add</button></div>`);
    const list = el(`<div class="list"></div>`);
    s.appendChild(add);
    s.appendChild(list);
    view.appendChild(s);

    async function load() {
      const cats = await api.get("/api/categories");
      list.innerHTML = "";
      if (!cats.length) list.appendChild(emptyBlock("\uD83D\uDDC2\uFE0F", "No categories yet."));
      cats.forEach((c) => {
        const row = el(`<div class="card product-card" style="grid-template-columns:1fr auto">
          <div><div class="name">${c.category_name}</div>
            <span class="pill ${c.status === "active" ? "active" : "inactive"}">${c.status}</span></div>
          <div style="display:flex;gap:6px">
            <button class="btn sm toggle">${c.status === "active" ? "Disable" : "Enable"}</button>
            <button class="btn sm danger del">Delete</button></div></div>`);
        row.querySelector(".toggle").onclick = async () => {
          await api.put("/api/categories/" + c.id, {
            status: c.status === "active" ? "inactive" : "active",
          });
          load();
        };
        row.querySelector(".del").onclick = async () => {
          try {
            await api.del("/api/categories/" + c.id);
            load();
          } catch (e) {
            alert(e.message);
          }
        };
        list.appendChild(row);
      });
    }
    add.querySelector("button").onclick = async () => {
      const name = add.querySelector("input").value.trim();
      if (!name) return;
      try {
        await api.post("/api/categories", { name });
        add.querySelector("input").value = "";
        load();
      } catch (e) {
        alert(e.message);
      }
    };
    await load();
  });

  // ---- Bill history ---------------------------------------------------------
  route("history", async () => {
    view.appendChild(topbar("Bill history"));
    const s = screen();
    view.appendChild(s);

    // Bulk delete tools (testing / admin).
    const tools = el(`<details class="card bulk-del">
      <summary>\uD83D\uDDD1 Bulk delete tools</summary>
      <button class="btn ghost sm bd-today" style="margin-top:10px">Clear today's bills</button>
      <div class="rep-minmax" style="margin-top:8px">
        <div class="field"><label>Delete by date</label><input class="input bd-date" type="date"/></div>
        <button class="btn ghost sm bd-date-go" style="align-self:end">Delete date</button>
      </div>
      <div class="rep-minmax">
        <div class="field"><label>From</label><input class="input bd-from" type="date"/></div>
        <div class="field"><label>To</label><input class="input bd-to" type="date"/></div>
      </div>
      <button class="btn ghost sm bd-range" style="width:auto">Delete range</button>
      <button class="btn sm bd-all" style="width:auto;background:#fee2e2;color:#b91c1c;border:none;margin-left:8px">Clear ALL bills</button>
    </details>`);
    s.appendChild(tools);
    const reloadHistory = () => go("history");
    tools.querySelector(".bd-today").onclick = async () => {
      if (!confirm("Delete all of today's bills? Stock will be restored.")) return;
      const r = await api.post("/api/admin/bills/clear-today", {}); globalToast(r.message); reloadHistory();
    };
    tools.querySelector(".bd-date-go").onclick = async () => {
      const d = tools.querySelector(".bd-date").value; if (!d) return alert("Pick a date.");
      if (!confirm("Delete all bills on " + d + "?")) return;
      const r = await api.post("/api/admin/bills/delete-by-date", { date: d }); globalToast(r.message); reloadHistory();
    };
    tools.querySelector(".bd-range").onclick = async () => {
      const f = tools.querySelector(".bd-from").value, t = tools.querySelector(".bd-to").value;
      if (!f || !t) return alert("Pick both dates.");
      if (!confirm(`Delete all bills from ${f} to ${t}?`)) return;
      const r = await api.post("/api/admin/bills/delete-by-range", { from: f, to: t }); globalToast(r.message); reloadHistory();
    };
    tools.querySelector(".bd-all").onclick = async () => {
      if (!confirm("This will permanently delete ALL bills and reports. This cannot be undone. Continue?")) return;
      const typed = prompt('Type exactly:  DELETE ALL BILLS');
      if (typed !== "DELETE ALL BILLS") return alert("Confirmation text did not match. Cancelled.");
      const r = await api.post("/api/admin/bills/clear-all", { confirm: "DELETE ALL BILLS" }); globalToast(r.message); reloadHistory();
    };

    // ---- Filters + search bar ----
    const todayIst = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
    const yIst = new Date(Date.now() - 864e5).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
    const isoToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });   // YYYY-MM-DD
    const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const bar = el(`<div class="card">
      <input class="input bh-search" type="text" placeholder="\uD83D\uDD0D Search by customer name, phone or bill number"/>
      <div class="mode-toggle" style="margin-top:8px;flex-wrap:wrap">
        <button class="mode-btn bh-f active" data-f="all">All</button>
        <button class="mode-btn bh-f" data-f="today">Today</button>
        <button class="mode-btn bh-f" data-f="yday">Yesterday</button>
        <button class="mode-btn bh-f" data-f="7">7 Days</button>
        <button class="mode-btn bh-f" data-f="30">30 Days</button>
        <button class="mode-btn bh-f" data-f="custom">Custom</button>
      </div>
      <div class="bh-custom rep-minmax" hidden style="margin-top:8px">
        <div class="field"><label>From</label><input class="input bh-from" type="date"/></div>
        <div class="field"><label>To</label><input class="input bh-to" type="date"/></div>
      </div>
    </div>`);
    s.appendChild(bar);
    const listWrap = el(`<div class="bh-list"></div>`);
    const moreWrap = el(`<div style="text-align:center;padding:16px"></div>`);
    s.appendChild(listWrap); s.appendChild(moreWrap);

    let filter = "all", offset = 0, loading = false, done = false;
    const PAGE = 50;
    let lastDayKey = null, dayAccumEl = null;

    const dateRange = () => {
      if (filter === "today") return { from: isoToday, to: isoToday };
      if (filter === "yday") return { from: isoDaysAgo(1), to: isoDaysAgo(1) };
      if (filter === "7") return { from: isoDaysAgo(6), to: isoToday };
      if (filter === "30") return { from: isoDaysAgo(29), to: isoToday };
      if (filter === "custom") return { from: bar.querySelector(".bh-from").value, to: bar.querySelector(".bh-to").value };
      return {};
    };

    async function loadPage(reset) {
      if (loading) return;
      if (reset) { offset = 0; done = false; listWrap.innerHTML = ""; lastDayKey = null; dayAccumEl = null; }
      if (done) return;
      loading = true;
      moreWrap.textContent = "Loading\u2026";
      const { from, to } = dateRange();
      const q = bar.querySelector(".bh-search").value.trim();
      const params = new URLSearchParams({ limit: PAGE, offset });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (q) params.set("q", q);
      try {
        const res = await api.get("/api/bills?" + params.toString());
        const items = res.items || [];
        if (offset === 0 && !items.length) {
          listWrap.appendChild(emptyBlock("\uD83E\uDDFE", q ? "No bills match." : "No bills in this range."));
        }
        // Group by IST date with day headers + running day totals.
        items.forEach((b) => {
          const key = b.date_ist || "\u2014";
          if (key !== lastDayKey) {
            lastDayKey = key;
            let label = key === todayIst ? "Today" : (key === yIst ? "Yesterday" : key);
            const header = el(`<div class="day-header"><span class="dh-date">${label}${label !== key ? " \u00B7 " + key : ""}</span><span class="dh-sum"></span></div>`);
            listWrap.appendChild(header);
            dayAccumEl = header.querySelector(".dh-sum");
            dayAccumEl._count = 0; dayAccumEl._sum = 0;
          }
          dayAccumEl._count += 1; dayAccumEl._sum += (b.grand_total || 0);
          dayAccumEl.textContent = `${dayAccumEl._count} bill${dayAccumEl._count === 1 ? "" : "s"} \u00B7 ${money(dayAccumEl._sum)}`;
          listWrap.appendChild(renderRow(b));
        });
        offset += items.length;
        done = !res.has_more;
        moreWrap.textContent = done ? (offset > 0 ? "\u2014 end \u2014" : "") : "";
        if (!done) {
          const btn = el(`<button class="btn ghost sm">Load more</button>`);
          btn.onclick = () => loadPage(false);
          moreWrap.innerHTML = ""; moreWrap.appendChild(btn);
        }
      } catch (e) { moreWrap.textContent = e.message; }
      loading = false;
    }

    bar.querySelectorAll(".bh-f").forEach((b) => {
      b.onclick = () => {
        bar.querySelectorAll(".bh-f").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        filter = b.dataset.f;
        bar.querySelector(".bh-custom").hidden = filter !== "custom";
        if (filter !== "custom") loadPage(true);
      };
    });
    bar.querySelector(".bh-from").onchange = () => { if (bar.querySelector(".bh-to").value) loadPage(true); };
    bar.querySelector(".bh-to").onchange = () => { if (bar.querySelector(".bh-from").value) loadPage(true); };
    let st;
    bar.querySelector(".bh-search").oninput = () => { clearTimeout(st); st = setTimeout(() => loadPage(true), 300); };

    // Infinite scroll: load next page when near the bottom.
    const onScroll = () => {
      if (done || loading) return;
      const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 400;
      if (nearBottom) loadPage(false);
    };

    const renderRow = (b) => {
      const cust = (b.customer_name || b.customer_mobile)
        ? `<div class="bh-cust"><b>${b.customer_name || "Customer"}</b>${b.customer_mobile ? ` <span class="muted sm">${b.customer_mobile}</span>` : ""}</div>`
        : `<div class="bh-cust muted">Walk-in Customer</div>`;
      const row = el(`<div class="card product-card" style="grid-template-columns:1fr auto auto auto;gap:8px;align-items:center">
        <div class="bill-open" style="cursor:pointer">
          ${cust}
          <div class="name" style="font-size:14px">${b.bill_number}</div>
          <div class="meta">${b.date_ist || ""} \u00B7 ${b.time_ist || ""} \u00B7 ${b.total_items} items \u00B7 ${(b.payment_method || "cash").toUpperCase()}</div></div>
        <div class="price">${money(b.grand_total)}</div>
        <button class="btn ghost sm bill-edit" title="Edit payment method" style="width:auto">\u270F\uFE0F</button>
        <button class="btn ghost sm bill-del" title="Delete bill" style="width:auto">\uD83D\uDDD1</button></div>`);
      row.querySelector(".bill-open").onclick = () => go("bill", { id: b.id });
      row.querySelector(".bill-edit").onclick = (e) => { e.stopPropagation(); editPaymentModal(b); };
      row.querySelector(".bill-del").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`This bill (${b.bill_number}) will be permanently deleted. Stock will be restored. Are you sure?`)) return;
        try {
          const r = await api.del("/api/bills/" + b.id);
          globalToast(r.message || "Bill deleted");
          go("history");
        } catch (err) { alert(err.message); }
      };
      return row;
    };

    // Edit payment method (uses the shared modal), then reload history.
    function editPaymentModal(b) { editBillPayment(b, () => go("history")); }

    // Everything is defined — kick off the first page + wire infinite scroll.
    window.addEventListener("scroll", onScroll, { passive: true });
    await loadPage(true);
  });

  route("bill", async (params) => {
    view.appendChild(topbar("Bill"));
    const s = screen();
    view.appendChild(s);
    const b = await api.get("/api/bills/" + params.id);
    // Header with bill number + date/time.
    s.appendChild(el(`<div class="card"><div class="name">${b.bill_number}</div>
      <div class="meta">${b.date_ist || ""} ${b.time_ist || ""}</div></div>`));

    // Customer card (shows saved details, or "Walk-in Customer").
    const hasCust = b.customer_name || b.customer_mobile;
    const custCard = el(`<div class="card">
      <div class="rep-h">Customer</div>
      ${hasCust ? `
        ${b.customer_name ? `<div class="setting-row"><span class="k">Name</span><span class="v">${b.customer_name}</span></div>` : ""}
        ${b.customer_mobile ? `<div class="setting-row" style="border:none"><span class="k">Phone</span><span class="v">${b.customer_mobile}</span></div>` : ""}
        ${b.customer_mobile ? `<button class="btn ghost sm cust-history" style="width:auto;margin-top:8px">\uD83D\uDCCB View purchase history</button>` : ""}
      ` : `<div class="muted">Walk-in Customer (no details captured)</div>`}
    </div>`);
    s.appendChild(custCard);
    if (b.customer_mobile) {
      custCard.querySelector(".cust-history").onclick = () => customerHistoryModal(b.customer_mobile, b.customer_name);
    }

    // Products purchased.
    s.appendChild(el(`<div class="rep-h" style="margin:14px 4px 6px">Products (${b.items.length})</div>`));
    b.items.forEach((it) =>
      s.appendChild(
        el(`<div class="cart-line"><div>${it.product_name}${it.manual ? ' <span class="pill" style="background:#7c3aed">Manual</span>' : ""}<div class="meta">${money(it.unit_price)} \u00D7 ${it.quantity}</div></div>
          <div></div><div class="price">${money(it.total_price)}</div></div>`)
      )
    );
    // Payment section (split breakdown if present).
    let payHtml = `<div class="setting-row" style="border:none"><span class="k">Payment</span><span class="v">${(b.payment_method || "cash").toUpperCase()}</span></div>`;
    if (b.payment_method === "split" && b.payment_breakdown) {
      payHtml = `<div class="setting-row"><span class="k">Payment</span><span class="v">SPLIT</span></div>`;
      ["cash", "upi", "card"].forEach((k) => {
        const v = b.payment_breakdown[k] || 0;
        if (v > 0) payHtml += `<div class="setting-row"><span class="k">${k.toUpperCase()}</span><span class="v">${money(v)}</span></div>`;
      });
    }
    s.appendChild(el(`<div class="card" style="margin-top:14px">
      <div class="setting-row"><span class="k">Subtotal</span><span class="v">${money(b.subtotal)}</span></div>
      <div class="setting-row"><span class="k">Discount</span><span class="v">\u2212${money(b.total_discount)}</span></div>
      <div class="setting-row"><span class="k">Grand total</span><span class="price">${money(b.grand_total)}</span></div>
      ${payHtml}
    </div>`));
    // Actions: print + edit payment.
    const acts = el(`<div class="btn-row" style="margin-top:14px;gap:8px">
      <button class="btn ghost bd-print" style="width:auto">\uD83D\uDDA8 Print</button>
      <button class="btn ghost bd-edit" style="width:auto">\u270F\uFE0F Edit Payment</button>
    </div>`);
    acts.querySelector(".bd-print").onclick = () => window.print();
    acts.querySelector(".bd-edit").onclick = () => editBillPayment(b, () => go("bill", { id: b.id }));
    s.appendChild(acts);
  });

  // Customer purchase-history popup (all bills for a phone number).
  async function customerHistoryModal(mobile, name) {
    const m = el(`<div class="modal" style="max-width:520px"><h3>Purchase History</h3>
      <div class="sub ch-sub">${name || "Customer"} \u00B7 ${mobile}</div>
      <div class="ch-summary muted sm" style="margin:6px 0">Loading\u2026</div>
      <div class="ch-list" style="max-height:50vh;overflow-y:auto"></div>
      <button class="btn ghost ch-close" style="margin-top:10px">Close</button></div>`);
    const ref = modal(m);
    m.querySelector(".ch-close").onclick = () => ref.resolve();
    try {
      const data = await api.get("/api/customers/history?mobile=" + encodeURIComponent(mobile));
      const bills = data.bills || [];
      m.querySelector(".ch-summary").textContent =
        `${data.total_bills} bill${data.total_bills === 1 ? "" : "s"} \u00B7 Total spent ${money(data.total_spent)}`;
      const list = m.querySelector(".ch-list");
      if (!bills.length) { list.innerHTML = `<div class="muted sm">No bills found.</div>`; return; }
      bills.forEach((bl) => {
        const row = el(`<div class="card" style="margin:6px 0;padding:10px;cursor:pointer">
          <div style="display:flex;justify-content:space-between">
            <div><b>${bl.bill_number}</b> <span class="muted sm">${bl.date_ist} ${bl.time_ist}</span></div>
            <div class="price">${money(bl.grand_total)}</div>
          </div>
          <div class="muted sm">${bl.total_items} items \u00B7 ${(bl.payment_method || "cash").toUpperCase()}</div></div>`);
        row.onclick = () => { ref.resolve(); go("bill", { id: bl.id }); };
        list.appendChild(row);
      });
    } catch (e) { m.querySelector(".ch-summary").textContent = e.message; }
  }

  // ---- Daily sales ----------------------------------------------------------
  route("daily", async () => {
    view.appendChild(topbar("Daily sales"));
    const s = screen();
    view.appendChild(s);
    const days = await api.get("/api/sales/daily");

    const clearBtn = el(`<button class="btn ghost sm" style="width:auto;margin-bottom:12px">\uD83D\uDDD1 Clear Today's Sales</button>`);
    clearBtn.onclick = async () => {
      if (!confirm("Delete all of today's sales entries? Stock will be restored. This cannot be undone.")) return;
      try { const r = await api.post("/api/sales/daily/clear-today", {}); globalToast(r.message); go("daily"); }
      catch (e) { alert(e.message); }
    };
    s.appendChild(clearBtn);

    if (!days.length) { s.appendChild(emptyBlock("\uD83D\uDCC8", "No sales recorded yet.")); return; }
    days.forEach((d) => {
      const card = el(`<div class="card">
        <div class="ds-head" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer">
          <div class="name">${d.date} <span class="ds-caret muted" style="font-size:11px">\u25BC</span></div>
          <button class="btn ghost sm ds-del" title="Delete this day" style="width:auto;color:#b91c1c">\uD83D\uDDD1</button>
        </div>
        <div class="setting-row"><span class="k">Bills</span><span class="v">${d.num_bills}</span></div>
        <div class="setting-row"><span class="k">Sales</span><span class="v">${money(d.total_sales)}</span></div>
        <div class="setting-row"><span class="k">Discount</span><span class="v">\u2212${money(d.total_discount)}</span></div>
        <div class="setting-row" style="border:none"><span class="k">Net</span><span class="price">${money(d.net_sales)}</span></div>
        <div class="ds-bills" hidden style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px"></div></div>`);

      const billsBox = card.querySelector(".ds-bills");
      let loaded = false;
      card.querySelector(".ds-head").onclick = async (e) => {
        if (e.target.closest(".ds-del")) return;
        billsBox.hidden = !billsBox.hidden;
        card.querySelector(".ds-caret").style.transform = billsBox.hidden ? "" : "rotate(180deg)";
        if (billsBox.hidden || loaded) return;
        billsBox.innerHTML = `<div class="muted sm">Loading bills\u2026</div>`;
        try {
          const res = await api.get(`/api/bills?from=${d.date}&to=${d.date}&limit=200`);
          const bills = res.items || [];
          loaded = true;
          if (!bills.length) { billsBox.innerHTML = `<div class="muted sm">No bills.</div>`; return; }
          billsBox.innerHTML = "";
          bills.forEach((b) => {
            const row = el(`<div class="card" style="margin:6px 0;padding:10px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div><b>${b.bill_number}</b> <span class="muted sm">${b.time_ist || ""}</span></div>
                <div class="price">${money(b.grand_total)}</div>
              </div>
              <div class="muted sm">${b.total_items} items \u00B7 ${(b.payment_method || "cash").toUpperCase()}</div>
              <div class="btn-row" style="margin-top:8px;gap:6px">
                <button class="btn ghost sm dsb-view" style="width:auto">\uD83D\uDC41 View</button>
                <button class="btn ghost sm dsb-print" style="width:auto">\uD83D\uDDA8 Print</button>
                <button class="btn ghost sm dsb-edit" style="width:auto">\u270F\uFE0F Payment</button>
              </div></div>`);
            row.querySelector(".dsb-view").onclick = () => go("bill", { id: b.id });
            row.querySelector(".dsb-print").onclick = () => { go("bill", { id: b.id }); setTimeout(() => window.print(), 600); };
            row.querySelector(".dsb-edit").onclick = () => editBillPayment(b, () => { loaded = false; billsBox.hidden = true; card.querySelector(".ds-head").click(); });
            billsBox.appendChild(row);
          });
        } catch (err) { billsBox.innerHTML = `<div class="msg">${err.message}</div>`; }
      };

      card.querySelector(".ds-del").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete all sales entries for ${d.date}?\n\nThis action cannot be undone.`)) return;
        try {
          const r = await api.del("/api/sales/daily/" + d.date);
          globalToast(r.message || "Sales cleared");
          card.remove();
        } catch (e) { alert(e.message); }
      };
      s.appendChild(card);
    });
  });

  // ---- Settings -------------------------------------------------------------
  route("settings", async () => {
    view.appendChild(topbar("Settings"));
    const s = screen();
    view.appendChild(s);
    const info = await api.get("/api/settings/info");
    s.appendChild(
      el(`<div class="card">
        <div class="setting-row"><span class="k">Version</span><span class="v">${info.version}</span></div>
        <div class="setting-row"><span class="k">Database</span><span class="v">${info.db_backend || info.database}</span></div>
        <div class="setting-row"><span class="k">Multi-device sync</span><span class="v sync-badge">checking\u2026</span></div>
        <div class="setting-row" style="border:none"><span class="k">Min images / product</span><span class="v">${info.min_product_images}</span></div>
      </div>`)
    );

    // Maintenance: remove duplicate products left by earlier imports.
    const maint = el(`<div class="card">
      <div class="setting-row" style="border:none"><span class="k">Duplicate products</span>
        <span class="v muted">Merge items with the same name</span></div>
      <button class="btn dedup" style="margin-top:10px">\uD83E\uDDF9 Remove duplicate products</button>
      <div class="msg dedup-msg" style="margin-top:8px"></div>
    </div>`);
    maint.querySelector(".dedup").onclick = async (e) => {
      const btn = e.target; const orig = btn.textContent;
      const m = maint.querySelector(".dedup-msg");
      if (!confirm("Merge products that share the same name and remove the extra copies? This keeps one of each.")) return;
      btn.textContent = "Cleaning\u2026"; btn.disabled = true; m.textContent = "";
      try {
        const r = await api.post("/api/products/deduplicate", {});
        m.className = "msg dedup-msg ok";
        m.textContent = `Done \u2014 removed ${r.removed} duplicate(s), ${r.unique_products} unique products remain.`;
        globalToast(`Removed ${r.removed} duplicates`);
      } catch (err) {
        m.className = "msg dedup-msg"; m.textContent = err.message;
      } finally {
        btn.textContent = orig; btn.disabled = false;
      }
    };
    s.appendChild(maint);

    // Recognition status + rebuild.
    const rec = el(`<div class="card">
      <div class="setting-row"><span class="k">Recognizer</span><span class="v">${info.recognizer}</span></div>
      <div class="setting-row"><span class="k">Products</span><span class="v">${info.product_count}</span></div>
      <div class="setting-row" style="border:none"><span class="k">Enrolled vectors</span><span class="v recvec">${info.indexed_vectors}</span></div>
      <button class="btn primary rebuild" style="margin-top:12px">Rebuild recognition index</button>
      <div class="muted" style="font-size:13px;margin-top:8px">Re-embeds every product's saved photos under the current recognizer. Run this after enrolling products or switching the recognizer model.</div>
    </div>`);
    rec.querySelector(".rebuild").onclick = async (e) => {
      const btn = e.target; const orig = btn.textContent;
      btn.textContent = "Rebuilding\u2026"; btn.disabled = true;
      try {
        const r = await api.post("/api/settings/reindex");
        rec.querySelector(".recvec").textContent = r.embedded;
        btn.textContent = `Done \u2014 ${r.embedded} images from ${r.products} products`;
        if (r.skipped) btn.textContent += ` (${r.skipped} skipped)`;
      } catch (err) {
        btn.textContent = "Failed: " + err.message;
      } finally {
        btn.disabled = false;
        setTimeout(() => { btn.textContent = orig; }, 4000);
      }
    };
    s.appendChild(rec);
    const backup = el(`<button class="btn" style="margin-bottom:10px">Backup / export database</button>`);
    backup.onclick = () => (window.location = "/api/settings/backup");
    const restore = el(`<label class="btn ghost" style="margin-bottom:10px">Restore from backup
      <input type="file" accept=".db" hidden/></label>`);
    restore.querySelector("input").onchange = async (e) => {
      const fd = new FormData();
      fd.append("backup", e.target.files[0]);
      try {
        const r = await api.form("/api/settings/restore", fd);
        alert(r.note || "Restored.");
      } catch (err) {
        alert(err.message);
      }
    };
    s.appendChild(backup);
    s.appendChild(restore);
  });

  // ---- Cash drawer: opening prompt (once per day) --------------------------
  async function checkCashOpening() {
    try {
      const st = await api.get("/api/cash/status");
      if (!st.needs_opening) return;
      const suggested = st.yesterday_closing != null ? st.yesterday_closing : (st.suggested_opening || 0);
      const m = el(`<div class="modal"><h3>\uD83D\uDCB0 Opening Cash</h3>
        ${st.yesterday_closing != null ? `<div class="sub">Yesterday's closing cash: ${money(st.yesterday_closing)}</div>` : `<div class="sub">Enter the cash you're starting the day with.</div>`}
        <div class="field"><label>Opening cash in drawer</label>
          <input class="input oc-val" type="number" inputmode="decimal" value="${suggested}"/></div>
        <button class="btn primary oc-start">Start Day</button></div>`);
      const ref = modal(m, { dismissable: false });
      m.querySelector(".oc-start").onclick = async () => {
        const v = parseFloat(m.querySelector(".oc-val").value);
        if (isNaN(v) || v < 0) { alert("Enter a valid amount."); return; }
        try { await api.post("/api/cash/open", { opening_cash: v }); ref.resolve(); globalToast("Day started"); }
        catch (e) { alert(e.message); }
      };
    } catch (_) { /* cash endpoint unavailable — don't block billing */ }
  }

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    const splash = document.getElementById("splash");
    setTimeout(() => splash.classList.add("hide"), 2000);
    if (!location.hash) location.hash = "home";
    render();
    checkCashOpening();
  }
  boot();
})();
