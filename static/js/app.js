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
  const cart = {
    lines: [], // {product_id, name, price, discount, qty}
    add(p) {
      const existing = this.lines.find((l) => l.product_id === p.product_id);
      if (existing) existing.qty += 1;
      else
        this.lines.push({
          product_id: p.product_id,
          name: p.product_name,
          price: p.selling_price,
          discount: p.discount || 0,
          qty: 1,
        });
      this.lastProductId = p.product_id;
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
    clear() {
      this.lines = [];
      this.lastProductId = null;
    },
    count() {
      return this.lines.reduce((s, l) => s + l.qty, 0);
    },
    total() {
      return this.lines.reduce((s, l) => s + (l.price - l.discount) * l.qty, 0);
    },
    payload() {
      return this.lines.map((l) => ({ product_id: l.product_id, quantity: l.qty }));
    },
  };

  // ---- Desktop shell --------------------------------------------------------
  const DESKTOP_QUERY = window.matchMedia("(min-width: 820px)");
  function isDesktop() { return DESKTOP_QUERY.matches; }

  function renderSidebar(active) {
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    const map = { product: "products", bill: "history" };
    const act = map[active] || active;
    sb.innerHTML = "";
    const logo = el(`<button class="side-logo">
      <img src="/static/img/logo.png" alt="RESVI"/>
      <span class="side-tag">Retail Products Store</span></button>`);
    logo.onclick = () => go("home");
    sb.appendChild(logo);
    const nav = el(`<nav class="side-nav"></nav>`);
    [
      ["scan", "New bill", "\uD83D\uDCF7"],
      ["products", "Products", "\uD83D\uDCE6"],
      ["categories", "Categories", "\uD83D\uDDC2\uFE0F"],
      ["inventory", "Inventory", "\uD83D\uDCCA"],
      ["history", "Bill history", "\uD83E\uDDFE"],
      ["daily", "Daily sales", "\uD83D\uDCC8"],
      ["settings", "Settings", "\u2699\uFE0F"],
    ].forEach(([r, label, ico]) => {
      const b = el(`<button class="side-item ${act === r ? "active" : ""}">
        <span class="si-ico">${ico}</span><span>${label}</span></button>`);
      b.onclick = () => go(r);
      nav.appendChild(b);
    });
    sb.appendChild(nav);
  }

  // ---- Router ---------------------------------------------------------------
  const routes = {};
  const route = (name, fn) => (routes[name] = fn);
  function go(name, params) {
    location.hash = name + (params ? "?" + new URLSearchParams(params) : "");
  }
  async function render() {
    const [name, qs] = (location.hash.replace(/^#/, "") || "home").split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const fn = routes[name] || routes.home;
    if (name !== "scan") stopCamera(); // leaving scan tears the camera down
    renderSidebar(name);
    view.innerHTML = "";
    try {
      await fn(params);
    } catch (e) {
      view.appendChild(errorBlock(e.message || "Something went wrong."));
    }
  }
  window.addEventListener("hashchange", render);
  // Re-render when crossing the desktop/mobile breakpoint so the layout swaps.
  DESKTOP_QUERY.addEventListener("change", render);

  // ---- Shared chrome --------------------------------------------------------
  function topbar(title, { back = true } = {}) {
    const bar = el(`<div class="topbar">
      ${back ? '<button class="back" aria-label="Back">\u2039</button>' : ""}
      <h1></h1><div class="spacer"></div>
      <span class="logo-chip"><img src="/static/img/logo.png" alt="RESVI"/></span>
    </div>`);
    bar.querySelector("h1").textContent = title;
    if (back) bar.querySelector(".back").onclick = () => history.back();
    return bar;
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
      t.onclick = () => go(target);
      return t;
    };
    actions.appendChild(make("Scan product", "\uD83D\uDCF7", "scan", true));
    actions.appendChild(make("Products", "\uD83D\uDCE6", "products"));
    actions.appendChild(make("Inventory", "\uD83D\uDCCA", "inventory"));
    actions.appendChild(make("Categories", "\uD83D\uDDC2\uFE0F", "categories"));
    actions.appendChild(make("Bill history", "\uD83E\uDDFE", "history"));
    actions.appendChild(make("Daily sales", "\uD83D\uDCC8", "daily"));
    actions.appendChild(make("Settings", "\u2699\uFE0F", "settings"));
    view.appendChild(home);
  });

  async function homeDashboard() {
    view.appendChild(topbar("Dashboard", { back: false }));
    const s = screen("dash");
    s.appendChild(el(`<div class="dash-hello">
      <div><h2>Welcome back</h2><div class="muted">Here's your store at a glance.</div></div>
      <button class="btn primary newbill" style="width:auto;padding:0 26px">\uD83D\uDCF7 New bill</button>
    </div>`));
    s.querySelector(".newbill").onclick = () => go("scan");

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
    quick.appendChild(qa("Add product", "\u2795", "product", "Enroll a new product with photos"));
    quick.appendChild(qa("Products", "\uD83D\uDCE6", "products", "Browse and manage your catalogue"));
    quick.appendChild(qa("Inventory", "\uD83D\uDCCA", "inventory", "Stock levels, stock-in and history"));
    quick.appendChild(qa("Categories", "\uD83D\uDDC2\uFE0F", "categories", "Organize products into groups"));
    quick.appendChild(qa("Bill history", "\uD83E\uDDFE", "history", "Review past bills"));
    quick.appendChild(qa("Daily sales", "\uD83D\uDCC8", "daily", "Day-by-day sales summary"));
    quick.appendChild(qa("Settings", "\u2699\uFE0F", "settings", "Backup, restore and app info"));
    s.appendChild(quick);
    view.appendChild(s);

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

  route("scan", async () => {
    const bar = topbar("Scan", { back: true });
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
          <input class="input picker-search" placeholder="Search products to add\u2026"/>
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
      scr.querySelector(".count").textContent = cart.count() + " item" + (cart.count() === 1 ? "" : "s");
      scr.querySelector(".total").textContent = money(cart.total());
      listEl.innerHTML = "";
      if (!cart.lines.length) {
        listEl.appendChild(el(`<div class="bill-empty">No items yet.<br/>Scan a product to begin.</div>`));
        return;
      }
      cart.lines.forEach((l) => {
        const row = el(`<div class="bill-line">
          <div class="bl-name">${l.name}<div class="bl-unit">${money(l.price - l.discount)} each</div></div>
          <div class="bl-qty"><button class="minus">\u2212</button><span>${l.qty}</span><button class="plus">+</button></div>
          <div class="bl-amt">${money((l.price - l.discount) * l.qty)}</div></div>`);
        row.querySelector(".minus").onclick = () => { cart.setQty(l.product_id, l.qty - 1); refreshBill(); };
        row.querySelector(".plus").onclick = () => { cart.setQty(l.product_id, l.qty + 1); refreshBill(); };
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
  function modal(node, { onCancel } = {}) {
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
    back.onclick = (e) => { if (e.target === back) finish(false); };
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
      <input class="input" placeholder="Search by name or code" style="margin-bottom:12px"/>
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
    if (!cart.count()) return;
    // Choose payment method first.
    const pay = await new Promise((resolve) => {
      const m = el(`<div class="modal"><h3>Payment method</h3>
        <div class="sub">${cart.count()} item(s) \u00B7 ${money(cart.total())}</div>
        <div class="pay-grid">
          <button class="pay-opt" data-m="cash">\uD83D\uDCB5 Cash</button>
          <button class="pay-opt" data-m="upi">\uD83D\uDCF1 UPI</button>
          <button class="pay-opt" data-m="card">\uD83D\uDCB3 Card</button>
        </div>
        <button class="btn ghost cancel" style="margin-top:10px">Cancel</button></div>`);
      const ref = modal(m);
      m.querySelectorAll(".pay-opt").forEach((b) => (b.onclick = () => { ref.resolve(); resolve(b.dataset.m); }));
      m.querySelector(".cancel").onclick = () => { ref.resolve(); resolve(null); };
    });
    if (!pay) return;
    try {
      const bill = await api.post("/api/bills/complete", { items: cart.payload(), payment_method: pay });
      cart.clear();
      refreshBill();
      const m = el(`<div class="modal"><h3>Bill saved</h3>
        <div class="sub">${bill.bill_number} \u00B7 ${money(bill.grand_total)} \u00B7 ${bill.payment_method.toUpperCase()}</div>
        <button class="btn primary">Start new bill</button></div>`);
      const ref = modal(m);
      m.querySelector("button").onclick = () => ref.resolve();
    } catch (e) {
      alert(e.message);
    }
  }

  // ---- Products -------------------------------------------------------------
  route("products", async () => {
    view.appendChild(topbar("Products"));
    const s = screen();
    const head = el(`<div class="searchbar">
      <input class="input" placeholder="Search by name or code"/>
      <div class="btn-row" style="margin-top:10px">
        <select class="input"><option value="">All categories</option></select>
        <button class="btn primary sm" style="width:auto;white-space:nowrap">+ Add</button>
      </div></div>`);
    const listWrap = el(`<div class="list product-grid"></div>`);
    s.appendChild(head);
    s.appendChild(listWrap);
    view.appendChild(s);

    const search = head.querySelector('input');
    const catSel = head.querySelector("select");
    head.querySelector("button").onclick = () => go("product");

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
    catSel.onchange = load;
    await load();
  });

  function productCard(p, reload) {
    const card = el(`<div class="card product-card">
      <img src="${p.primary_image_id ? api.imageUrl(p.primary_image_id) : ""}" alt=""/>
      <div><div class="name">${p.product_name}</div>
        <div class="meta">${p.product_code} \u00B7 ${p.category_name || ""}</div>
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
        <div class="field" style="flex:1"><label>${editing ? "Stock (use Inventory to change)" : "Opening stock"}</label>
          <input class="input" name="quantity" type="number" inputmode="numeric" value="${product ? product.quantity : "0"}" ${editing ? "disabled" : ""}/></div>
        <div class="field" style="flex:1"><label>Min stock level</label>
          <input class="input" name="min_stock_level" type="number" inputmode="numeric" value="${product ? product.min_stock_level : "0"}"/></div>
      </div>
      <div class="field"><label>Description (optional)</label>
        <input class="input" name="description" value="${product && product.description ? product.description : ""}"/></div>
      <div class="field"><label>Size family (optional — share across sizes of the same item)</label>
        <input class="input" name="family_key" value="${product && product.family_key ? product.family_key : ""}"/></div>
      ${editing ? "" : `<div class="field"><label>Images (minimum 5, white background)</label>
        <input class="input" name="images" type="file" accept="image/*" multiple capture="environment"/></div>`}
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
            min_stock_level: form.querySelector('[name="min_stock_level"]').value,
            description: form.querySelector('[name="description"]').value,
            family_key: form.querySelector('[name="family_key"]').value,
          });
        } else {
          const fd = new FormData();
          fd.append("name", form.querySelector('[name="name"]').value);
          fd.append("category_id", sel.value);
          fd.append("selling_price", form.querySelector('[name="selling_price"]').value);
          fd.append("cost_price", form.querySelector('[name="cost_price"]').value);
          fd.append("discount", form.querySelector('[name="discount"]').value);
          fd.append("quantity", form.querySelector('[name="quantity"]').value);
          fd.append("min_stock_level", form.querySelector('[name="min_stock_level"]').value);
          fd.append("description", form.querySelector('[name="description"]').value);
          fd.append("family_key", form.querySelector('[name="family_key"]').value);
          const files = form.querySelector('[name="images"]').files;
          for (const f of files) fd.append("images", f);
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
    const bills = await api.get("/api/bills");
    if (!bills.length) return s.appendChild(emptyBlock("\uD83E\uDDFE", "No bills yet."));
    bills.forEach((b) => {
      const d = new Date(b.bill_date);
      const row = el(`<div class="card product-card" style="grid-template-columns:1fr auto">
        <div><div class="name">${b.bill_number}</div>
          <div class="meta">${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} \u00B7 ${b.total_items} items</div></div>
        <div class="price">${money(b.grand_total)}</div></div>`);
      row.onclick = () => go("bill", { id: b.id });
      s.appendChild(row);
    });
  });

  route("bill", async (params) => {
    view.appendChild(topbar("Bill"));
    const s = screen();
    view.appendChild(s);
    const b = await api.get("/api/bills/" + params.id);
    s.appendChild(el(`<div class="card"><div class="name">${b.bill_number}</div>
      <div class="meta">${new Date(b.bill_date).toLocaleString()}</div></div>`));
    b.items.forEach((it) =>
      s.appendChild(
        el(`<div class="cart-line"><div>${it.product_name}<div class="meta">${money(it.unit_price)} \u00D7 ${it.quantity}</div></div>
          <div></div><div class="price">${money(it.total_price)}</div></div>`)
      )
    );
    s.appendChild(el(`<div class="card" style="margin-top:14px">
      <div class="setting-row"><span class="k">Subtotal</span><span class="v">${money(b.subtotal)}</span></div>
      <div class="setting-row"><span class="k">Discount</span><span class="v">\u2212${money(b.total_discount)}</span></div>
      <div class="setting-row" style="border:none"><span class="k">Grand total</span><span class="price">${money(b.grand_total)}</span></div>
    </div>`));
  });

  // ---- Daily sales ----------------------------------------------------------
  route("daily", async () => {
    view.appendChild(topbar("Daily sales"));
    const s = screen();
    view.appendChild(s);
    const days = await api.get("/api/sales/daily");
    if (!days.length) return s.appendChild(emptyBlock("\uD83D\uDCC8", "No sales recorded yet."));
    days.forEach((d) =>
      s.appendChild(
        el(`<div class="card"><div class="name">${d.date}</div>
          <div class="setting-row"><span class="k">Bills</span><span class="v">${d.num_bills}</span></div>
          <div class="setting-row"><span class="k">Sales</span><span class="v">${money(d.total_sales)}</span></div>
          <div class="setting-row"><span class="k">Discount</span><span class="v">\u2212${money(d.total_discount)}</span></div>
          <div class="setting-row" style="border:none"><span class="k">Net</span><span class="price">${money(d.net_sales)}</span></div></div>`)
      )
    );
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
        <div class="setting-row"><span class="k">Database</span><span class="v">${info.database}</span></div>
        <div class="setting-row" style="border:none"><span class="k">Min images / product</span><span class="v">${info.min_product_images}</span></div>
      </div>`)
    );

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

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    const splash = document.getElementById("splash");
    setTimeout(() => splash.classList.add("hide"), 2000);
    if (!location.hash) location.hash = "home";
    render();
  }
  boot();
})();
