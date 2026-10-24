"use strict";

/* ================================================================ constants */

const APERTURES = [null, "1.2", "1.4", "1.8", "2", "2.8", "3.5", "4", "5.6", "8", "11", "16", "22", "32"];
const SHUTTERS = [null, "B", "8\"", "4\"", "2\"", "1\"", "1/2", "1/4", "1/8", "1/15", "1/30", "1/60",
                  "1/125", "1/250", "1/500", "1/1000", "1/2000", "1/4000"];
const ISOS = [null, 25, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 3200, 6400];
const EXPOSURES = [10, 12, 16, 24, 27, 36];

const STOCKS = {
  "Colour": [["Kodak Portra 160", 160], ["Kodak Portra 400", 400], ["Kodak Portra 800", 800],
             ["Kodak Ektar 100", 100], ["Kodak Gold 200", 200], ["Kodak Ultramax 400", 400],
             ["Kodak ColorPlus 200", 200], ["Fujifilm 200", 200], ["Fujifilm 400", 400],
             ["CineStill 800T", 800], ["CineStill 400D", 400], ["CineStill 50D", 50],
             ["Lomography 400", 400], ["Lomography 800", 800]],
  "Black & white": [["Ilford HP5 Plus", 400], ["Ilford FP4 Plus", 125], ["Ilford Delta 100", 100],
                    ["Ilford Delta 400", 400], ["Ilford Delta 3200", 3200], ["Ilford Pan F Plus", 50],
                    ["Ilford XP2 Super", 400], ["Kodak Tri-X 400", 400], ["Kodak T-Max 100", 100],
                    ["Kodak T-Max 400", 400], ["Kentmere Pan 400", 400]],
  "Slide": [["Kodak Ektachrome E100", 100], ["Fujifilm Velvia 50", 50], ["Fujifilm Provia 100F", 100]],
};
const STOCK_ISO = Object.fromEntries(Object.values(STOCKS).flat());
const LEGACY_OUTBOX_KEY = "film-journal-outbox";   // pre-IndexedDB queue, migrated on boot
const CURRENT_KEY = "film-journal-current-roll";

/* ================================================================ helpers */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
const settingsText = (f) => {
  const parts = [f.aperture && `f/${f.aperture}`, f.shutter].filter(Boolean);
  return parts.length ? parts.join("  ·  ") : null;
};

async function api(path, { json, timeout = 15000, ...opts } = {}) {
  const init = { ...opts, cache: "no-store" };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { "Content-Type": "application/json" };
  }
  // Weak signal can leave a request hanging for minutes: give up and let the queue retry.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  init.signal = ctrl.signal;
  let res;
  try { res = await fetch(path, init); } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

function haptic() {
  try { navigator.vibrate?.(8); } catch { /* iOS Safari has no vibrate */ }
}

/* ================================================================ dial */

class Dial {
  constructor(el, values, { label = (v) => (v ?? "—"), onInput = () => {}, onChange = () => {} } = {}) {
    Object.assign(this, { el, label, onInput, onChange });
    this.idx = 0;
    this.track = document.createElement("div");
    this.track.className = "dial-track";
    el.appendChild(this.track);
    this.track.addEventListener("scroll", () => this._onScroll(), { passive: true });
    this.track.addEventListener("click", (e) => {
      const item = e.target.closest(".dial-item");
      if (item) this._scrollTo(+item.dataset.i, true);
    });
    this.setValues(values);
  }

  setValues(values) {
    const keep = this.value;
    this.values = values;
    this.track.innerHTML = values
      .map((v, i) => `<div class="dial-item${v === null ? " nil" : ""}" data-i="${i}">${esc(this.label(v))}</div>`)
      .join("");
    this.items = [...this.track.children];
    this.set(keep);
  }

  get value() { return this.values ? this.values[this.idx] : null; }

  set(value) {
    const i = this.values.findIndex((v) => String(v) === String(value));
    this.idx = i < 0 ? 0 : i;
    this.sync();
  }

  /** Re-apply scroll position: needed after the dial was hidden (no layout = no scroll). */
  sync() {
    this._scrollTo(this.idx, false);
    this._highlight(this.idx);
  }

  mark(predicate, cls) {
    this.items.forEach((it, i) => it.classList.toggle(cls, predicate(this.values[i])));
  }

  get _w() { return this.items[0]?.offsetWidth || 64; }

  _scrollTo(i, smooth) {
    this.track.scrollTo({ left: i * this._w, behavior: smooth ? "smooth" : "instant" });
  }

  _onScroll() {
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        const i = this._current();
        if (i !== this.hi) {
          this._highlight(i);
          haptic();
          this.onInput(this.values[i]);
        }
      });
    }
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      const i = this._current();
      if (i !== this.idx) {
        this.idx = i;
        this.onChange(this.value);
      }
    }, 120);
  }

  _current() {
    return Math.max(0, Math.min(this.values.length - 1, Math.round(this.track.scrollLeft / this._w)));
  }

  _highlight(i) {
    this.hi = i;
    this.items.forEach((it, j) => {
      it.classList.toggle("on", j === i);
      it.classList.toggle("near", Math.abs(j - i) === 1);
    });
  }
}
/* ================================================================ dials */

const dials = {};

function buildDials() {
  dials.iso = new Dial($("#dial-iso"), ISOS);
  dials.frame = new Dial($("#dial-frame"), [1], {
    onInput: (v) => { $("#frame-number").textContent = v; $("#save-num").textContent = v; },
    onChange: () => loadFrameIntoForm(),
  });
  dials.aperture = new Dial($("#dial-aperture"), APERTURES, {
    onInput: (v) => ($("#val-aperture").textContent = v ? `f/${v}` : "—"),
  });
  dials.shutter = new Dial($("#dial-shutter"), SHUTTERS, {
    onInput: (v) => ($("#val-shutter").textContent = v ?? "—"),
  });
}

function setDial(name, value) {
  dials[name].set(value);
  dials[name].onInput(dials[name].value);
}

/* ================================================================ load-roll form */

function cameraOptions(selected) {
  const opts = [`<option value="">No camera</option>`]
    .concat(S.cameras.map((c) => `<option ${c.name === selected ? "selected" : ""}>${esc(c.name)}</option>`))
    .concat(`<option value="__add">+ Add camera…</option>`);
  return opts.join("");
}

function stockOptions(selected) {
  let found = !selected;
  const group = (name, items) => `<optgroup label="${esc(name)}">` + items.map((s) => {
    if (s === selected) found = true;
    return `<option ${s === selected ? "selected" : ""}>${esc(s)}</option>`;
  }).join("") + "</optgroup>";
  let html = `<option value="">Unknown stock</option>`;
  const custom = S.knownStocks.filter((s) => !(s in STOCK_ISO));
  if (custom.length) html += group("Used before", custom);
  for (const [name, list] of Object.entries(STOCKS)) html += group(name, list.map(([s]) => s));
  if (!found) html += `<option selected>${esc(selected)}</option>`;
  html += `<option value="__other">Other…</option>`;
  return html;
}

function wireCameraSelect(select, addBox, input, button, onCamera = () => {}) {
  select.onchange = () => {
    addBox.hidden = select.value !== "__add";
    if (!addBox.hidden) input.focus();
    const cam = S.cameras.find((c) => c.name === select.value);
    if (cam?.exposures) onCamera(cam);
  };
  button.onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    await enqueue("addCamera", name, { name });
    select.innerHTML = cameraOptions(name);
    addBox.hidden = true;
    input.value = "";
  };
}

function wireStockSelect(select, custom, onIso) {
  select.onchange = () => {
    custom.hidden = select.value !== "__other";
    if (!custom.hidden) custom.focus();
    if (STOCK_ISO[select.value]) onIso(STOCK_ISO[select.value]);
  };
}
const stockValue = (select, custom) => select.value === "__other" ? custom.value.trim() : select.value;
const cameraValue = (select) => (select.value === "__add" ? "" : select.value);

function segmented(el, values, selected, onPick) {
  el.innerHTML = values.map((v) => `<button type="button" class="${v === selected ? "on" : ""}" data-v="${v}">${v}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onPick(+b.dataset.v);
  };
}

function renderLoadForm() {
  const last = S.lastRoll || {};
  $("#camera-select").innerHTML = cameraOptions(last.camera);
  $("#stock-select").innerHTML = stockOptions(last.film_stock);
  $("#stock-custom").hidden = true;
  $("#camera-add").hidden = true;
  setExposures(last.exposures || 36);
  dials.iso.set(last.iso ?? STOCK_ISO[last.film_stock] ?? 400);
}

function setExposures(n) {
  S.exposures = n;
  segmented($("#exposures-seg"), EXPOSURES, n, (v) => (S.exposures = v));
}

async function startRoll() {
  const data = {
    client_id: newId(),
    camera: cameraValue($("#camera-select")),
    film_stock: stockValue($("#stock-select"), $("#stock-custom")),
    iso: dials.iso.value,
    exposures: S.exposures,
    started_at: new Date().toISOString(),
  };
  await enqueue("createRoll", data.client_id, data);
  selectRoll(data.client_id);
  location.hash = "";
  toast("Roll loaded");
}

/* ================================================================ local store (IndexedDB)
 *
 * Offline-first: every change is an "op" queued in IndexedDB (photos as Blobs),
 * the screen shows the last copy of the Pi's data with pending ops applied on top,
 * and sync() replays ops to the Pi in order whenever it is reachable.
 */

const idb = (() => {
  let opening;
  const open = () => (opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("film-journal", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  };
  return {
    get: (k) => tx("kv", "readonly", (s) => s.get(k)),
    set: (k, v) => tx("kv", "readwrite", (s) => s.put(v, k)),
    ops: () => tx("ops", "readonly", (s) => s.getAll()),
    addOp: (op) => tx("ops", "readwrite", (s) => s.add(op)),
    delOp: (seq) => tx("ops", "readwrite", (s) => s.delete(seq)),
  };
})();

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
const rollRef = (r) => r.client_id || String(r.id);
const sameRoll = (r, ref) => r.client_id === ref || String(r.id) === String(ref);

const S = {
  server: { active: [], cameras: [], last_roll: null, rolls: [] },   // last copy from the Pi
  ops: [],              // queued changes, oldest first
  online: null,         // null = unknown yet
  actives: [], cameras: [], lastRoll: null, rolls: [],              // server + ops (what we render)
  currentRef: (() => { try { return localStorage.getItem(CURRENT_KEY); } catch { return null; } })(),
  get active() { return this.actives.find((r) => sameRoll(r, this.currentRef)) || this.actives[0] || null; },
  get frames() { return this.active?.frames || []; },
  knownStocks: [],
  photo: null,          // Blob of a fresh snapshot for the current frame
  carry: { aperture: null, shutter: null },
  exposures: 36,
};

const blobUrls = new Map();   // op seq -> object URL for queued snapshots
function blobUrl(op) {
  if (!blobUrls.has(op.seq)) blobUrls.set(op.seq, URL.createObjectURL(op.photo));
  return blobUrls.get(op.seq);
}

function applyOps() {
  const actives = S.server.active.map((r) => ({
    ...r, frames: r.frames.map((f) => ({ ...f, thumb: f.photo && `/photos/${f.photo}` })),
  }));
  const rolls = S.server.rolls.map((r) => ({ ...r }));
  const cameras = S.server.cameras.map((c) => ({ ...c }));
  let lastRoll = S.server.last_roll;

  for (const op of S.ops) {
    const live = actives.find((r) => sameRoll(r, op.ref));
    const listed = rolls.find((r) => sameRoll(r, op.ref));
    switch (op.type) {
      case "createRoll":
        if (!live && !listed) {
          actives.push({ ...op.data, id: null, frames: [], pending: true });
          rolls.unshift({ ...op.data, id: null, frame_count: 0, cover: null, pending: true });
        }
        lastRoll = op.data;
        break;
      case "updateRoll":
        if (live) Object.assign(live, op.data);
        if (listed) Object.assign(listed, op.data);
        break;
      case "finishRoll":
        if (live) actives.splice(actives.indexOf(live), 1);
        if (listed) listed.finished_at = op.data.finished_at;
        break;
      case "saveFrame":
        if (live) {
          const old = live.frames.find((f) => f.frame_no === op.data.frame_no);
          const frame = { ...op.data, pending: true,
                          thumb: op.photo ? blobUrl(op) : old?.thumb, photo: old?.photo };
          live.frames = live.frames.filter((f) => f !== old).concat(frame).sort((a, b) => a.frame_no - b.frame_no);
        }
        break;
      case "addCamera":
        if (!cameras.some((c) => c.name === op.data.name)) cameras.push({ ...op.data, id: null });
        break;
    }
  }
  for (const r of rolls) {
    const live = actives.find((a) => sameRoll(a, rollRef(r)));
    if (live) r.frame_count = live.frames.length;
  }
  cameras.sort((a, b) => a.name.localeCompare(b.name));
  Object.assign(S, { actives, rolls, cameras, lastRoll });
  S.knownStocks = [...new Set(rolls.map((r) => r.film_stock).filter(Boolean))];
}

/** Apply queued edits to a roll fetched from (or cached for) the detail page. */
function overlayRoll(roll) {
  const r = { ...roll };
  for (const op of S.ops) {
    if (!sameRoll(r, op.ref)) continue;
    if (op.type === "updateRoll") Object.assign(r, op.data);
    if (op.type === "finishRoll") r.finished_at ||= op.data.finished_at;
  }
  return r;
}

async function enqueue(type, ref, data, photo = null) {
  const op = { type, ref, data, photo, queued_at: new Date().toISOString() };
  // A newer save of the same frame replaces an older one that hasn't gone out yet.
  if (type === "saveFrame") {
    for (const old of S.ops.filter((o) => o.type === "saveFrame" && o.ref === ref && o.data.frame_no === data.frame_no)) {
      if (!photo && old.photo) { op.photo = old.photo; }
      await dropOp(old);
    }
  }
  try {
    op.seq = await idb.addOp(op);
  } catch {
    op.seq = -Date.now();   // IndexedDB unavailable: keep in memory for this session
  }
  S.ops.push(op);
  applyOps();
  renderStatus();
  sync();
  return op;
}

async function dropOp(op) {
  S.ops = S.ops.filter((o) => o !== op);
  if (blobUrls.has(op.seq)) { URL.revokeObjectURL(blobUrls.get(op.seq)); blobUrls.delete(op.seq); }
  if (op.seq > 0) await idb.delOp(op.seq).catch(() => {});
}

/* ================================================================ sync */

function sendOp(op) {
  const ref = encodeURIComponent(op.ref);
  switch (op.type) {
    case "createRoll": return api("/api/rolls", { method: "POST", json: op.data });
    case "updateRoll": return api(`/api/rolls/${ref}`, { method: "PATCH", json: op.data });
    case "finishRoll": return api(`/api/rolls/${ref}/finish`, { method: "POST", json: op.data });
    case "addCamera": return api("/api/cameras", { method: "POST", json: op.data });
    case "saveFrame": {
      const fd = new FormData();
      for (const k of ["frame_no", "aperture", "shutter", "note", "shot_at"]) fd.append(k, op.data[k] ?? "");
      if (op.photo) fd.append("photo", op.photo, `frame-${op.data.frame_no}.jpg`);
      return api(`/api/rolls/${ref}/frames`, { method: "POST", body: fd, timeout: 60000 });
    }
  }
  return Promise.resolve();
}

async function pull() {
  const [st, list] = await Promise.all([api("/api/state"), api("/api/rolls")]);
  S.server = { active: st.active, cameras: st.cameras, last_roll: st.last_roll, rolls: list.rolls };
  idb.set("server", S.server).catch(() => {});
}

async function sync() {
  if (sync.running) { sync.again = true; return; }
  sync.running = true;
  try {
    do {
      sync.again = false;
      for (const op of [...S.ops]) {
        try {
          await sendOp(op);
        } catch (e) {
          if (!e.status || e.status >= 500) throw e;           // unreachable: keep the queue, retry later
          toast(`Couldn't sync a change (${e.message}) — skipped`);   // rejected: don't retry forever
        }
        await dropOp(op);
      }
      await pull();
    } while (sync.again);
    setOnline(true);
  } catch {
    setOnline(false);
  } finally {
    sync.running = false;
    applyOps();
    rerender();
  }
}

function setOnline(v) {
  S.online = v;
  renderStatus();
}

function renderStatus() {
  const b = $("#outbox-badge");
  const n = S.ops.length;
  b.hidden = S.online !== false && !n;
  b.textContent = S.online === false
    ? (n ? `Offline · ${n} to sync` : "Offline")
    : `Syncing ${n}…`;
}

/* ================================================================ shoot screen */

const allFrames = () => S.frames;

function nextFrameNo() {
  const frames = allFrames();
  return frames.length ? Math.max(...frames.map((f) => f.frame_no)) + 1 : 1;
}

function renderShoot() {
  const r = S.active;
  $("#chip-camera").textContent = r.camera || "No camera";
  $("#chip-stock").textContent = [r.film_stock || "Unknown stock", r.iso && `ISO ${r.iso}`].filter(Boolean).join(" · ");
  const frames = allFrames();
  $("#chip-count").textContent = `${frames.length} of ${r.exposures} logged`;
  $("#roll-progress-bar").style.width = `${Math.min(100, (frames.length / r.exposures) * 100)}%`;

  const maxNo = Math.max(r.exposures + 3, nextFrameNo() + 1);
  const values = Array.from({ length: maxNo + 1 }, (_, i) => i);
  if (dials.frame.values.length !== values.length) dials.frame.setValues(values);
  const logged = new Set(frames.map((f) => f.frame_no));
  dials.frame.mark((v) => logged.has(v), "logged");

  $("#recent").innerHTML = frames.slice().reverse().map(frameRow).join("");
}

function frameRow(f) {
  const settings = settingsText(f);
  const thumb = f.thumb ?? (f.photo && `/photos/${f.photo}`);
  const sub = [f.pending ? "not synced yet" : fmtTime(f.shot_at), f.note].filter(Boolean).join(" · ");
  return `<button class="frame-row" data-frame="${f.frame_no}">
      <span class="no">${f.frame_no}</span>
      <span class="meta">${settings ? esc(settings) : `<span class="blank">No settings</span>`}<small>${esc(sub)}</small></span>
      <img class="thumb ${thumb ? "" : "none"}" src="${thumb ? esc(thumb) : ""}" alt="" loading="lazy">
    </button>`;
}

function goToFrame(no) {
  setDial("frame", no);
  loadFrameIntoForm();
}

/** Logged frame → show its values (saving overwrites). New frame → carry last settings. */
function loadFrameIntoForm() {
  const no = dials.frame.value;
  const frames = allFrames();
  const f = frames.find((x) => x.frame_no === no);
  // After a reload S.carry is empty: fall back to the most recent frame that had settings.
  const carry = S.carry.aperture || S.carry.shutter ? S.carry
    : frames.filter((x) => x.aperture || x.shutter).sort((a, b) => a.shot_at < b.shot_at ? -1 : 1).pop() || {};
  $("#frame-status").hidden = !f;
  setDial("aperture", f ? f.aperture : carry.aperture);
  setDial("shutter", f ? f.shutter : carry.shutter);
  $("#note").value = f?.note || "";
  S.photo = null;
  showSnapshot(f?.thumb || null);
}

function showSnapshot(src) {
  $("#snap-preview").hidden = !src;
  $("#snap-empty").hidden = !!src;
  $("#snap-tile").classList.toggle("has-photo", !!src);
  if (src) $("#snap-preview").src = src;
}

function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", 0.82);
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function saveFrame(blank) {
  const no = dials.frame.value;
  const roll = S.active;
  const data = {
    frame_no: no,
    aperture: blank ? null : dials.aperture.value,
    shutter: blank ? null : dials.shutter.value,
    note: blank ? "" : $("#note").value.trim(),
    shot_at: new Date().toISOString(),
  };
  if (!blank) S.carry = { aperture: data.aperture, shutter: data.shutter };
  haptic();
  toast(blank ? `Frame ${no} skipped` : `Frame ${no} saved`);
  await enqueue("saveFrame", rollRef(roll), data, blank ? null : S.photo);
  renderShoot();
  goToFrame(nextFrameNo());
}

/* ================================================================ sheets */

function openSheet(html, wire) {
  const sheet = $("#sheet");
  sheet.innerHTML = html;
  sheet.hidden = false;
  $("#sheet-backdrop").hidden = false;
  wire?.(sheet);
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}

const needsPi = (e) => toast(e.status ? e.message : "Needs a connection to the Pi");

function editRollSheet(roll, after) {
  openSheet(`
    <h2>Roll details</h2>
    <label class="field-label">Camera</label>
    <select class="select" id="e-camera">${cameraOptions(roll.camera)}</select>
    <div class="inline-add" id="e-camera-add" hidden>
      <input class="input" id="e-camera-new" placeholder="Camera name"><button class="btn btn-small" id="e-camera-btn">Add</button>
    </div>
    <label class="field-label">Film stock</label>
    <select class="select" id="e-stock">${stockOptions(roll.film_stock)}</select>
    <input class="input" id="e-stock-custom" placeholder="Film stock name" hidden style="margin-top:8px">
    <label class="field-label">ISO</label>
    <select class="select" id="e-iso">${ISOS.map((v) => `<option value="${v ?? ""}" ${v === roll.iso ? "selected" : ""}>${v ?? "—"}</option>`).join("")}</select>
    <label class="field-label">Exposures</label>
    <div class="segmented" id="e-exp"></div>
    <button class="btn btn-primary btn-big" id="e-save">Save</button>`,
  (s) => {
    let exposures = roll.exposures;
    segmented(s.querySelector("#e-exp"), EXPOSURES, exposures, (v) => (exposures = v));
    wireCameraSelect(s.querySelector("#e-camera"), s.querySelector("#e-camera-add"), s.querySelector("#e-camera-new"), s.querySelector("#e-camera-btn"),
                     (cam) => { exposures = cam.exposures; segmented(s.querySelector("#e-exp"), EXPOSURES, exposures, (v) => (exposures = v)); });
    wireStockSelect(s.querySelector("#e-stock"), s.querySelector("#e-stock-custom"), (iso) => (s.querySelector("#e-iso").value = iso));
    s.querySelector("#e-save").onclick = async () => {
      const iso = s.querySelector("#e-iso").value;
      await enqueue("updateRoll", rollRef(roll), {
        camera: cameraValue(s.querySelector("#e-camera")),
        film_stock: stockValue(s.querySelector("#e-stock"), s.querySelector("#e-stock-custom")),
        iso: iso ? +iso : null,
        exposures,
      });
      closeSheet();
      after();
    };
  });
}

function finishSheet() {
  const roll = S.active;
  const n = allFrames().length;
  openSheet(`
    <h2>Finish this roll?</h2>
    <p>${n} frame${n === 1 ? "" : "s"} logged on ${esc(roll.film_stock || "this roll")}. You can add a description next.</p>
    <button class="btn btn-danger btn-big" id="f-yes">Finish roll</button>
    <button class="btn btn-big" id="f-no">Keep shooting</button>`,
  (s) => {
    s.querySelector("#f-no").onclick = closeSheet;
    s.querySelector("#f-yes").onclick = async () => {
      const finished_at = new Date().toISOString();
      await enqueue("finishRoll", rollRef(roll), { finished_at });
      showShoot();
      describeSheet({ ...roll, finished_at }, rerender);
    };
  });
}

function describeSheet(roll, after) {
  openSheet(`
    <h2>Describe the roll</h2>
    <p>${esc([roll.film_stock, roll.camera].filter(Boolean).join(" in ")) || "Roll"} · started ${fmtDate(roll.started_at)}</p>
    <label class="field-label">Title</label>
    <input class="input" id="d-title" placeholder="e.g. Lisbon weekend" value="${esc(roll.title)}">
    <label class="field-label">Description</label>
    <textarea class="input" id="d-desc" rows="6" placeholder="Where, who, light, how it was developed…">${esc(roll.description)}</textarea>
    <button class="btn btn-primary btn-big" id="d-save">Save</button>
    <button class="btn btn-big" id="d-later">Later</button>`,
  (s) => {
    s.querySelector("#d-later").onclick = () => { closeSheet(); after(); };
    s.querySelector("#d-save").onclick = async () => {
      await enqueue("updateRoll", rollRef(roll), {
        title: s.querySelector("#d-title").value.trim() || null,
        description: s.querySelector("#d-desc").value.trim() || null,
      });
      closeSheet();
      toast("Saved");
      after();
    };
  });
}

function frameSheet(roll, f, after) {
  const settings = settingsText(f);
  const img = f.thumb ?? (f.photo && `/photos/${f.photo}`);
  openSheet(`
    ${img ? `<img class="sheet-photo" src="${esc(img)}" alt="">` : ""}
    <h2>Frame ${f.frame_no}</h2>
    <p>${settings ? esc(settings) : "No settings recorded"} · ${fmtDate(f.shot_at)} ${fmtTime(f.shot_at)}${f.note ? `<br>${esc(f.note)}` : ""}</p>
    ${f.pending ? "" : `<button class="btn btn-big btn-danger-text" id="fr-del">Delete frame</button>`}`,
  (s) => {
    const del = s.querySelector("#fr-del");
    if (del) del.onclick = async () => {
      try {
        await api(`/api/rolls/${encodeURIComponent(rollRef(roll))}/frames/${f.frame_no}`, { method: "DELETE" });
        closeSheet();
        after();
        sync();
      } catch (e) { needsPi(e); }
    };
  });
}

/* ================================================================ rolls & detail */

function renderRolls() {
  const rolls = S.rolls;
  $("#roll-list").innerHTML = rolls.length ? rolls.map((r) => `
    <button class="roll-card" data-roll="${esc(rollRef(r))}">
      ${r.cover ? `<img class="cover" src="/photos/${esc(r.cover)}" alt="" loading="lazy">`
                : `<div class="cover">${r.iso ? esc(r.iso) : "—"}</div>`}
      <div>
        <div class="t">${esc(r.title || r.film_stock || "Untitled roll")}</div>
        <div class="s">${esc([r.title && r.film_stock, r.camera].filter(Boolean).join(" · "))}</div>
        <div class="s">${r.finished_at ? fmtDate(r.started_at) : `<span class="live">In camera</span>`} · ${r.frame_count} frame${r.frame_count === 1 ? "" : "s"}${r.pending ? " · not synced yet" : ""}</div>
      </div>
    </button>`).join("") : `<div class="empty">No rolls yet</div>`;
}

async function renderRollDetail(ref) {
  let r, frames, partial = false;
  const live = S.actives.find((x) => sameRoll(x, ref));
  try {
    if (live?.pending) throw new Error("not on the Pi yet");
    const res = await api(`/api/rolls/${encodeURIComponent(ref)}`);
    r = overlayRoll(res.roll);
    frames = res.frames;
    if (live) frames = live.frames;          // includes frames still queued
  } catch {
    // Offline: build what we can from the local copy.
    r = live || S.rolls.find((x) => sameRoll(x, ref));
    if (!r) { $("#roll-detail").innerHTML = `<div class="empty">This roll isn't available offline</div>`; return; }
    r = overlayRoll(r);
    frames = live ? live.frames : [];
    partial = !live;
  }
  $("#detail-heading").textContent = r.title || r.film_stock || "Roll";
  const photos = frames.filter((f) => f.thumb || f.photo);
  const img = (f) => f.thumb ?? `/photos/${f.photo}`;
  $("#roll-detail").innerHTML = `
    <div class="card">
      ${r.description ? `<p style="margin:0 0 14px;white-space:pre-wrap">${esc(r.description)}</p>` : ""}
      <div class="detail-meta">
        <div><small>Camera</small><span>${esc(r.camera || "—")}</span></div>
        <div><small>Film</small><span>${esc(r.film_stock || "—")}</span></div>
        <div><small>ISO</small><span>${esc(r.iso || "—")}</span></div>
        <div><small>Frames</small><span>${partial ? r.frame_count ?? "—" : frames.length} / ${r.exposures}</span></div>
        <div><small>Loaded</small><span>${fmtDate(r.started_at)}</span></div>
        <div><small>Finished</small><span>${r.finished_at ? fmtDate(r.finished_at) : "In camera"}</span></div>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" id="rd-describe">${r.description ? "Edit notes" : "Describe"}</button>
      <button class="btn" id="rd-edit">Edit details</button>
    </div>
    ${partial ? `<div class="empty">Frames will show when you're connected to the Pi</div>` : `
    ${photos.length ? `<div class="section-title">Snapshots</div><div class="contact-sheet">${photos.map((f) =>
      `<button data-frame="${f.frame_no}"><img src="${esc(img(f))}" alt="" loading="lazy"><span>${f.frame_no}</span></button>`).join("")}</div>` : ""}
    <div class="section-title">Frames</div>
    <div class="frame-list" id="rd-frames">${frames.map(frameRow).join("")}</div>`}
    <div class="btn-row" style="margin-top:16px">
      ${r.finished_at ? `<button class="btn" id="rd-reopen">Reload roll</button>` : "<span></span>"}
      <button class="btn btn-danger-text" id="rd-delete">Delete roll</button>
    </div>`;

  const reload = () => renderRollDetail(ref);
  $("#rd-describe").onclick = () => describeSheet(r, reload);
  $("#rd-edit").onclick = () => editRollSheet(r, reload);
  $("#roll-detail").querySelectorAll("[data-frame]").forEach((b) => {
    b.onclick = () => frameSheet(r, frames.find((f) => f.frame_no === +b.dataset.frame), reload);
  });
  const reopen = $("#rd-reopen");
  if (reopen) reopen.onclick = async () => {
    try {
      await api(`/api/rolls/${encodeURIComponent(ref)}/reopen`, { method: "POST" });
      await pull();
      applyOps();
      selectRoll(ref);
      location.hash = "";
    } catch (e) { needsPi(e); }
  };
  $("#rd-delete").onclick = () => openSheet(`
      <h2>Delete this roll?</h2>
      <p>${frames.length} frames and ${photos.length} snapshots will be removed from the Pi. The NAS copy of the photos is kept.</p>
      <button class="btn btn-danger btn-big" id="x-yes">Delete roll</button>
      <button class="btn btn-big" id="x-no">Cancel</button>`,
    (s) => {
      s.querySelector("#x-no").onclick = closeSheet;
      s.querySelector("#x-yes").onclick = async () => {
        try {
          if (r.pending) {
            for (const op of S.ops.filter((o) => o.ref === ref)) await dropOp(op);
          } else {
            await api(`/api/rolls/${encodeURIComponent(ref)}`, { method: "DELETE" });
            await pull();
          }
          applyOps();
          closeSheet();
          location.hash = "#rolls";
        } catch (e) { needsPi(e); }
      };
    });
}

/* ================================================================ routing */

function selectRoll(ref) {
  S.currentRef = ref;
  S.carry = { aperture: null, shutter: null };
  try { localStorage.setItem(CURRENT_KEY, ref); } catch { /* ignore */ }
}

const shortStock = (s) => (s || "Film").replace(/^(Kodak|Ilford|Fujifilm|Fuji|Kentmere|Lomography|CineStill) /, "");

function renderRollTabs() {
  $("#roll-tabs").innerHTML = S.actives.map((r) => `
      <button class="roll-tab ${r === S.active ? "on" : ""}" data-tab="${esc(rollRef(r))}">
        <b>${esc(r.camera || "No camera")}</b><span>${esc(shortStock(r.film_stock))}</span>
      </button>`).join("") +
    `<button class="roll-tab roll-tab-add" data-nav="new" aria-label="Load another roll">＋</button>`;
}

function showShoot() {
  $("#no-roll").hidden = !!S.active;
  $("#shoot").hidden = !S.active;
  if (!S.active) return;
  renderRollTabs();
  renderShoot();
  dials.aperture.sync();
  dials.shutter.sync();
  const ref = rollRef(S.active);
  if (showShoot.ref !== ref) goToFrame(nextFrameNo());   // switched roll
  else dials.frame.sync();
  showShoot.ref = ref;
}

const currentView = () => {
  const h = location.hash;
  return h.startsWith("#roll/") ? "roll" : h === "#rolls" ? "rolls" : h === "#new" ? "new" : "shoot";
};

/** Refresh the visible screen after data changed (but never yank a form out from under the user). */
function rerender() {
  const view = currentView();
  if (view === "shoot") showShoot();
  if (view === "rolls") renderRolls();
  if (view === "new") refreshLoadOptions();
}

/** Fresh cameras/stocks arrived: update the dropdowns, keeping whatever is picked. */
function refreshLoadOptions() {
  const cam = $("#camera-select"), stock = $("#stock-select");
  if (cam.value !== "__add") cam.innerHTML = cameraOptions(cam.value || S.lastRoll?.camera);
  if (stock.value !== "__other") stock.innerHTML = stockOptions(stock.value || S.lastRoll?.film_stock);
}

async function route() {
  closeSheet();
  const view = currentView();
  for (const v of ["shoot", "rolls", "roll", "new"]) $(`#view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
  if (view === "shoot") showShoot();
  if (view === "new") renderLoadForm();
  if (view === "rolls") renderRolls();
  if (view === "roll") await renderRollDetail(decodeURIComponent(location.hash.slice(6)));
}

/* ================================================================ boot */

function wire() {
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) location.hash = nav.dataset.nav === "shoot" ? "" : `#${nav.dataset.nav}`;
    const tab = e.target.closest("[data-tab]");
    if (tab && tab.dataset.tab !== rollRef(S.active)) { selectRoll(tab.dataset.tab); showShoot(); }
    const roll = e.target.closest("[data-roll]");
    if (roll) location.hash = `#roll/${encodeURIComponent(roll.dataset.roll)}`;
  });
  $("#recent").addEventListener("click", (e) => {
    const row = e.target.closest("[data-frame]");
    if (row) { goToFrame(+row.dataset.frame); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  $("#sheet-backdrop").onclick = closeSheet;

  wireCameraSelect($("#camera-select"), $("#camera-add"), $("#camera-new"), $("#camera-add-btn"),
                   (cam) => setExposures(cam.exposures));
  wireStockSelect($("#stock-select"), $("#stock-custom"), (iso) => dials.iso.set(iso));
  $("#start-roll").onclick = startRoll;

  $("#roll-chip").onclick = () => editRollSheet(S.active, rerender);
  $("#save-frame").onclick = () => saveFrame(false);
  $("#save-blank").onclick = () => saveFrame(true);
  $("#finish-roll").onclick = finishSheet;

  $("#snap-input").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      S.photo = await shrinkImage(file);
      showSnapshot(URL.createObjectURL(S.photo));
    } catch {
      toast("Couldn't read that photo");
    }
  };

  $("#outbox-badge").onclick = () => sync();
  window.addEventListener("hashchange", route);
  window.addEventListener("online", sync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  // Keep trying while offline or behind; otherwise refresh now and then.
  setInterval(() => { if (S.ops.length || S.online === false) sync(); }, 15000);
}

async function migrateLegacyOutbox() {
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_OUTBOX_KEY)) || []; } catch { return; }
  for (const o of legacy) {
    const photo = o.photo ? await (await fetch(o.photo)).blob() : null;
    const { frame_no, aperture, shutter, note, shot_at } = o;
    await enqueue("saveFrame", String(o.roll_id), { frame_no, aperture, shutter, note, shot_at }, photo);
  }
  try { localStorage.removeItem(LEGACY_OUTBOX_KEY); } catch { /* ignore */ }
}

(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.storage?.persist?.().catch(() => {});   // ask iOS not to evict queued photos
  buildDials();
  wire();
  try {
    S.server = (await idb.get("server")) || S.server;
    S.ops = (await idb.ops()) || [];
  } catch { /* IndexedDB unavailable: online-only for this session */ }
  applyOps();
  renderStatus();
  await route();
  await migrateLegacyOutbox();
  sync();
})();
