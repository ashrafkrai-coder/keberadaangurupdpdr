import { auth, db } from "./firebase-init.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, collection,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { DEFAULT_CONFIG, checkDuty, effectiveStatus } from "./session.js";
import { LocationTracker } from "./tracker.js";
import { initAdminTools } from "./admin-tools.js";

/* ---------------- Utiliti ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SNAP_OPTS = { serverTimestamps: "estimate" };

const STATUS = {
  online:           { label: "Aktif",          sub: "Dalam kawasan sekolah",         badge: "bg-green-100 text-green-700", icon: "bg-green-100 text-green-600", color: "#16a34a" },
  "luar-zon":       { label: "Luar Zon",       sub: "Di luar kawasan sekolah",       badge: "bg-red-100 text-red-700",     icon: "bg-red-100 text-red-600",     color: "#dc2626" },
  offline:          { label: "Offline",        sub: "Tiada isyarat lokasi terkini",  badge: "bg-amber-100 text-amber-700", icon: "bg-amber-100 text-amber-600", color: "#d97706" },
  "tidak-bertugas": { label: "Tidak Bertugas", sub: "Di luar waktu bertugas",        badge: "bg-slate-200 text-slate-600", icon: "bg-slate-100 text-slate-500", color: "#94a3b8" },
};

const SESSION_LABEL = { pagi: "Sesi Pagi", petang: "Sesi Petang", "kedua-dua": "Pagi & Petang" };

function show(view) {
  for (const v of ["loading", "login", "teacher", "admin"]) {
    $("view-" + v).classList.toggle("hidden", v !== view);
  }
}

function ago(ts) {
  const ms = ts?.toMillis?.();
  if (!ms) return "–";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "Baru sahaja";
  if (s < 3600) return `${Math.floor(s / 60)} min lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

function clock(tz) {
  return new Intl.DateTimeFormat("ms-MY", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date());
}

/* ---------------- State ---------------- */
const state = {
  user: null,
  me: null,        // dokumen teachers/{uid} sendiri
  config: DEFAULT_CONFIG,
  teachers: [],    // untuk admin
  unsubs: [],
  timers: [],
};
let tracker = null;

function cleanup() {
  state.unsubs.forEach((u) => u());
  state.timers.forEach(clearInterval);
  state.unsubs = [];
  state.timers = [];
}

/* ---------------- Auth ---------------- */
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  err.classList.add("hidden");
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
  } catch (ex) {
    err.textContent = "E-mel atau kata laluan tidak betul.";
    err.classList.remove("hidden");
  } finally {
    $("login-btn").disabled = false;
  }
});

document.querySelectorAll("[data-logout]").forEach((b) =>
  b.addEventListener("click", async () => {
    try { await tracker?.stop("logout"); } catch {}
    cleanup();
    tracker = null;
    await signOut(auth);
  })
);

onAuthStateChanged(auth, async (user) => {
  cleanup();
  if (!user) { state.user = null; show("login"); return; }
  show("loading");
  try {
    const [cfg, me] = await Promise.all([
      getDoc(doc(db, "config", "school")),
      getDoc(doc(db, "teachers", user.uid)),
    ]);
    if (!me.exists() || me.data().active === false) {
      await signOut(auth);
      const err = $("login-error");
      err.textContent = "Akaun anda tidak didaftarkan atau tidak aktif. Hubungi pentadbir.";
      err.classList.remove("hidden");
      return;
    }
    state.user = user;
    state.config = { ...DEFAULT_CONFIG, ...(cfg.exists() ? cfg.data() : {}) };
    state.me = { id: user.uid, ...me.data() };
    state.me.role === "admin" ? startAdmin() : startTeacher();
  } catch (ex) {
    console.error(ex);
    await signOut(auth);
    const err = $("login-error");
    err.textContent = "Gagal memuatkan data: " + ex.message;
    err.classList.remove("hidden");
  }
});

/* =====================================================
   DASHBOARD GURU
   ===================================================== */
function startTeacher() {
  show("teacher");
  const cfg = state.config;
  $("t-school").textContent = cfg.name || "Sekolah";
  $("t-name").textContent = state.me.name;
  $("t-session").textContent = SESSION_LABEL[state.me.session] || state.me.session;

  tracker = new LocationTracker({
    uid: state.user.uid,
    session: state.me.session,
    config: cfg,
    onUpdate: () => renderTeacher(),
    onError: (m) => {
      const el = $("t-error");
      el.textContent = m;
      el.classList.remove("hidden");
    },
  });

  // Langgan dokumen sendiri (paparan masa nyata)
  state.unsubs.push(
    onSnapshot(doc(db, "teachers", state.user.uid), (snap) => {
      state.me = { id: snap.id, ...snap.data(SNAP_OPTS) };
      renderTeacher();
    })
  );
  state.timers.push(setInterval(renderTeacher, 30000));

  // Sambung semula jika sebelum ini sedang berkongsi (cth. app dimuat semula)
  if (state.me.sharing && checkDuty(state.me.session, cfg).active) tracker.start();
  renderTeacher();
}

$("t-toggle").addEventListener("click", async () => {
  $("t-error").classList.add("hidden");
  $("t-toggle").disabled = true;
  try {
    tracker.running ? await tracker.stop() : await tracker.start();
  } finally {
    renderTeacher();
  }
});

function renderTeacher() {
  const t = state.me;
  if (!t || !tracker) return;
  const duty = checkDuty(t.session, state.config);
  const key = effectiveStatus(t, state.config);
  const st = STATUS[key];

  // Kad status
  const icon = $("t-status-icon");
  icon.className = `relative mx-auto h-20 w-20 rounded-full flex items-center justify-center ${st.icon} ${key === "online" ? "pulse" : ""}`;
  $("t-status-label").textContent = st.label;
  $("t-status-sub").textContent = key === "tidak-bertugas" ? duty.label : st.sub;

  // Butang
  const btn = $("t-toggle");
  const running = tracker.running;
  btn.textContent = running ? "Henti Kongsi Lokasi" : "Mula Kongsi Lokasi";
  btn.className =
    "w-full rounded-2xl py-4 text-lg font-semibold text-white shadow-lg transition active:scale-[.98] disabled:opacity-50 disabled:cursor-not-allowed " +
    (running ? "bg-red-600 hover:bg-red-700 shadow-red-200" : "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200");
  btn.disabled = !running && !duty.active;
  $("t-hint").textContent = running
    ? "Biarkan app terbuka. Skrin dikekalkan menyala."
    : duty.active ? `${duty.label} sedang berjalan.` : "Penjejakan hanya boleh dimulakan pada waktu bertugas.";

  // Lokasi
  const loc = t.lastLocation;
  $("t-lat").textContent = loc ? loc.lat.toFixed(6) : "–";
  $("t-lng").textContent = loc ? loc.lng.toFixed(6) : "–";
  $("t-acc").textContent = loc ? `± ${loc.accuracy} m` : "–";
  $("t-time").textContent = ago(t.lastUpdate);
  const geo = $("t-geo");
  const g = t.geofence;
  geo.textContent = g === "dalam" ? "Dalam sekolah" : g === "luar" ? "Luar sekolah" : "–";
  geo.className =
    "inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold " +
    (g === "dalam" ? "bg-green-100 text-green-700" : g === "luar" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600");
}

/* =====================================================
   DASHBOARD PENTADBIR
   ===================================================== */
let map = null;
const markers = new Map(); // uid -> L.circleMarker

function startAdmin() {
  show("admin");
  const cfg = state.config;
  $("a-school").textContent = cfg.name || "Sekolah";
  $("a-name").textContent = state.me.name;

  initMap();
  initAdminTools(state);

  state.unsubs.push(
    onSnapshot(
      collection(db, "teachers"),
      (snap) => {
        state.teachers = snap.docs
          .map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }))
          .filter((t) => t.role !== "admin" && t.active !== false)
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderAdmin();
      },
      (err) => console.error("Firestore:", err)
    )
  );

  state.timers.push(setInterval(renderAdmin, 30000));
  state.timers.push(setInterval(() => ($("a-clock").textContent = clock(cfg.timezone)), 1000));
  ["f-q", "f-session", "f-status"].forEach((id) => $(id).addEventListener("input", renderAdmin));
}

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 100); return; }
  const c = state.config.center;
  map = L.map("map").setView([c.lat, c.lng], 17);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);
  L.circle([c.lat, c.lng], {
    radius: state.config.radiusMeters, color: "#4f46e5", weight: 2, fillColor: "#4f46e5", fillOpacity: 0.06, dashArray: "6 6",
  }).addTo(map).bindTooltip("Kawasan sekolah");
  setTimeout(() => map.invalidateSize(), 100);
}

function statCard(label, value, color) {
  return `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
    <p class="text-xs text-slate-500">${label}</p>
    <p class="mt-1 text-2xl font-bold ${color}">${value}</p></div>`;
}

function renderAdmin() {
  const cfg = state.config;
  const rows = state.teachers.map((t) => ({ ...t, eff: effectiveStatus(t, cfg) }));

  // Stats
  const count = (fn) => rows.filter(fn).length;
  $("a-stats").innerHTML =
    statCard("Jumlah Guru", rows.length, "text-slate-800") +
    statCard("Sesi Pagi", count((t) => t.session !== "petang"), "text-indigo-600") +
    statCard("Sesi Petang", count((t) => t.session !== "pagi"), "text-indigo-600") +
    statCard("Hadir (Aktif)", count((t) => t.eff === "online"), "text-green-600") +
    statCard("Luar Kawasan", count((t) => t.eff === "luar-zon"), "text-red-600") +
    statCard("Offline", count((t) => t.eff === "offline"), "text-amber-600");

  // Tapisan
  const q = $("f-q").value.trim().toLowerCase();
  const fs = $("f-session").value;
  const fst = $("f-status").value;
  const list = rows.filter(
    (t) =>
      (!q || (t.name || "").toLowerCase().includes(q)) &&
      (!fs || t.session === fs || t.session === "kedua-dua") &&
      (!fst || t.eff === fst)
  );

  // Jadual
  $("a-count").textContent = `${list.length} / ${rows.length} guru`;
  $("a-empty").classList.toggle("hidden", list.length > 0);
  $("a-rows").innerHTML = list
    .map((t) => {
      const st = STATUS[t.eff];
      return `<tr data-uid="${esc(t.id)}" class="cursor-pointer hover:bg-slate-50">
        <td class="px-4 py-3"><p class="font-medium">${esc(t.name)}</p>
          <p class="text-xs text-slate-500">${esc(SESSION_LABEL[t.session] || t.session)}${t.battery != null ? ` &middot; 🔋${esc(t.battery)}%` : ""}</p></td>
        <td class="px-2 py-3"><span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.badge}">${st.label}</span></td>
        <td class="px-4 py-3 text-right text-xs text-slate-500 whitespace-nowrap">${ago(t.lastUpdate)}</td></tr>`;
    })
    .join("");

  // Penanda peta (tidak dipaparkan di luar waktu bertugas)
  const visible = new Set();
  for (const t of list) {
    if (!t.lastLocation || t.eff === "tidak-bertugas") continue;
    visible.add(t.id);
    const st = STATUS[t.eff];
    const pos = [t.lastLocation.lat, t.lastLocation.lng];
    const popup = `<b>${esc(t.name)}</b><br>${st.label} &middot; ${esc(ago(t.lastUpdate))}<br><small>±${esc(t.lastLocation.accuracy)} m</small>`;
    let m = markers.get(t.id);
    if (!m) {
      m = L.circleMarker(pos, { radius: 9, weight: 3, color: "#fff", fillOpacity: 0.95 }).addTo(map);
      m.bindPopup(popup);
      markers.set(t.id, m);
    } else {
      m.setLatLng(pos);
      m.setPopupContent(popup);
    }
    m.setStyle({ fillColor: st.color, fillOpacity: t.eff === "offline" ? 0.5 : 0.95 });
  }
  for (const [uid, m] of markers) {
    if (!visible.has(uid)) { m.remove(); markers.delete(uid); }
  }
}

// Klik baris -> zum ke penanda
$("a-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-uid]");
  const m = tr && markers.get(tr.dataset.uid);
  if (!m) return;
  map.flyTo(m.getLatLng(), 18);
  m.openPopup();
  $("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(console.error));
}

let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  $("install-btn").classList.remove("hidden");
});
$("install-btn").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("install-btn").classList.add("hidden");
});
