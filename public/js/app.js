import { auth, db } from "./firebase-init.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, collection, query, where, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  DEFAULT_CONFIG, windowState, isLateAt, homeCheck, dateKey, weekdayOfKey, sessionsOf, minutesNow,
} from "./session.js";
import { initAdminTools } from "./admin-tools.js";

/* ---------------- Utiliti ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SNAP = { serverTimestamps: "estimate" };

const SESSION_LABEL = { pagi: "Sesi Pagi", petang: "Sesi Petang", "kedua-dua": "Pagi & Petang" };

const SLOT = {
  hadir:         { label: "Hadir",       badge: "bg-green-100 text-green-700", color: "#16a34a" },
  lewat:         { label: "Lewat",       badge: "bg-amber-100 text-amber-700", color: "#d97706" },
  belum:         { label: "Belum",       badge: "bg-sky-100 text-sky-700",     color: "#0ea5e9" },
  "tidak-hadir": { label: "Tidak Hadir", badge: "bg-red-100 text-red-700",     color: "#dc2626" },
};

function show(view) {
  for (const v of ["loading", "login", "teacher", "admin"]) $("view-" + v).classList.toggle("hidden", v !== view);
}

const timeOf = (ts, tz) =>
  ts?.toDate
    ? new Intl.DateTimeFormat("ms-MY", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(ts.toDate())
    : "–";

const prettyDate = (key, tz) =>
  new Intl.DateTimeFormat("ms-MY", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(new Date(key + "T00:00:00Z"));

function clock(tz) {
  return new Intl.DateTimeFormat("ms-MY", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date());
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject({ code: 0 });
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 20000, maximumAge: 0,
    });
  });
}

function geoMessage(ex) {
  if (ex && ex.code === 1) return "Kebenaran lokasi ditolak. Aktifkan lokasi untuk app ini dalam tetapan peranti.";
  if (ex && ex.code === 2) return "Lokasi tidak dapat ditentukan. Hidupkan GPS dan cuba di tempat terbuka.";
  if (ex && ex.code === 3) return "Masa menunggu GPS tamat. Cuba lagi.";
  if (ex && ex.code === 0) return "Peranti ini tidak menyokong Geolocation.";
  if (ex && ex.code === "permission-denied") return "Ditolak oleh pelayan. Mungkin anda sudah check-in untuk sesi ini.";
  return ex?.message || "Ralat tidak dijangka.";
}

/* ---------------- State ---------------- */
const state = {
  user: null,
  me: null,
  config: DEFAULT_CONFIG,
  myCheckins: [],   // guru: rekod terkini sendiri
  teachers: [],     // admin
  checkins: [],     // admin: rekod pada tarikh dipilih
  date: null,       // admin: tarikh dipilih (YYYY-MM-DD)
  unsubs: [],
  timers: [],
};
let ciUnsub = null;

function cleanup() {
  state.unsubs.forEach((u) => u());
  state.timers.forEach(clearInterval);
  state.unsubs = [];
  state.timers = [];
  ciUnsub?.();
  ciUnsub = null;
}

/* ---------------- Auth ---------------- */
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  err.classList.add("hidden");
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
  } catch {
    err.textContent = "E-mel atau kata laluan tidak betul.";
    err.classList.remove("hidden");
  } finally {
    $("login-btn").disabled = false;
  }
});

document.querySelectorAll("[data-logout]").forEach((b) =>
  b.addEventListener("click", async () => {
    cleanup();
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

  state.unsubs.push(
    onSnapshot(doc(db, "teachers", state.user.uid), (snap) => {
      state.me = { id: snap.id, ...snap.data(SNAP) };
      renderTeacher();
    })
  );
  state.unsubs.push(
    onSnapshot(
      query(collection(db, "checkins"), where("uid", "==", state.user.uid), orderBy("date", "desc"), limit(14)),
      (snap) => {
        state.myCheckins = snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
        renderTeacher();
      },
      (err) => showTeacherError("Gagal memuatkan rekod: " + err.message)
    )
  );
  state.timers.push(setInterval(renderTeacher, 30000));
  renderTeacher();
}

function showTeacherError(msg) {
  const el = $("t-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function slotCard(name) {
  const cfg = state.config;
  const tz = cfg.timezone;
  const w = windowState(name, cfg);
  const today = dateKey(tz);
  const ci = state.myCheckins.find((c) => c.date === today && c.session === name);
  const s = cfg.sessions[name];
  const hasHome = !!state.me.home;

  let tone, title, sub, action = "";
  if (ci) {
    const late = isLateAt(ci.timestamp.toDate(), name, cfg);
    tone = late ? "amber" : "green";
    title = late ? "Check-in Lewat" : "Sudah Check-in";
    sub = `Pukul ${timeOf(ci.timestamp, tz)}` +
      (ci.homeStatus === "luar" ? ` · Luar lokasi rumah (${ci.distanceFromHome} m)` : " · Di rumah");
  } else if (w.state === "cuti") {
    tone = "slate"; title = "Hari Cuti"; sub = "Tiada check-in pada hujung minggu.";
  } else if (w.state === "belum-buka") {
    tone = "slate"; title = "Belum Dibuka"; sub = `Check-in dibuka pukul ${w.opensAt}.`;
  } else if (w.state === "tutup") {
    tone = "red"; title = "Tidak Check-in"; sub = "Sesi telah tamat.";
  } else {
    tone = w.late ? "amber" : "indigo";
    title = w.late ? "Belum Check-in (Lewat)" : "Belum Check-in";
    sub = hasHome ? "Tekan butang untuk check-in dari rumah." : "Daftar lokasi rumah dahulu.";
    action = `<button data-checkin="${name}" ${hasHome ? "" : "disabled"}
      class="mt-4 w-full rounded-xl py-3.5 text-base font-semibold text-white shadow-md transition active:scale-[.98] disabled:opacity-50 disabled:cursor-not-allowed ${w.late ? "bg-amber-600 hover:bg-amber-700" : "bg-indigo-600 hover:bg-indigo-700"}">Check-in Sekarang</button>`;
  }

  const ring = { green: "bg-green-100 text-green-600", amber: "bg-amber-100 text-amber-600", red: "bg-red-100 text-red-600", slate: "bg-slate-100 text-slate-500", indigo: "bg-indigo-100 text-indigo-600" }[tone];
  const icon = ci
    ? '<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>'
    : '<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z"/>';

  return `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
    <div class="flex items-center gap-4">
      <div class="h-14 w-14 shrink-0 rounded-full flex items-center justify-center ${ring}">
        <svg class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">${icon}</svg></div>
      <div class="min-w-0">
        <p class="text-xs text-slate-500">${SESSION_LABEL[name]} &middot; ${esc(s.start)}&ndash;${esc(s.end)}</p>
        <p class="text-lg font-bold">${title}</p>
        <p class="text-sm text-slate-500">${esc(sub)}</p>
      </div>
    </div>${action}</div>`;
}

function renderTeacher() {
  const t = state.me;
  if (!t) return;
  const cfg = state.config;
  const today = dateKey(cfg.timezone);
  $("t-date").textContent = prettyDate(today, cfg.timezone);
  $("t-home-card").classList.toggle("hidden", !!t.home);
  $("t-slots").innerHTML = sessionsOf(t.session).map(slotCard).join("");

  const rows = state.myCheckins;
  $("t-history-empty").classList.toggle("hidden", rows.length > 0);
  $("t-history").innerHTML = rows
    .map((c) => {
      const late = c.timestamp?.toDate ? isLateAt(c.timestamp.toDate(), c.session, cfg) : c.late;
      const st = SLOT[late ? "lewat" : "hadir"];
      return `<li class="flex items-center justify-between py-2.5">
        <div><p class="font-medium">${esc(c.date)}</p><p class="text-xs text-slate-500">${SESSION_LABEL[c.session]} &middot; ${esc(timeOf(c.timestamp, cfg.timezone))}</p></div>
        <div class="flex gap-1.5">
          ${c.homeStatus === "luar" ? '<span class="rounded-full px-2 py-0.5 text-xs font-semibold bg-red-100 text-red-700">Luar lokasi</span>' : ""}
          <span class="rounded-full px-2 py-0.5 text-xs font-semibold ${st.badge}">${st.label}</span></div></li>`;
    })
    .join("");
}

// Check-in
$("t-slots").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-checkin]");
  if (!btn) return;
  const name = btn.dataset.checkin;
  const cfg = state.config;
  showTeacherError("");

  const w = windowState(name, cfg);
  const key = dateKey(cfg.timezone);
  if (w.state !== "buka") return showTeacherError("Check-in tidak dibuka pada masa ini.");
  if (!state.me.home) return showTeacherError("Daftar lokasi rumah dahulu.");
  if (state.myCheckins.some((c) => c.date === key && c.session === name)) return;

  btn.disabled = true;
  btn.textContent = "Mengesan lokasi…";
  try {
    const pos = await getPosition();
    const point = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
    if (point.accuracy > 500) {
      throw { message: `Isyarat GPS lemah (±${point.accuracy} m). Hidupkan GPS dan cuba di tempat terbuka.` };
    }
    const hc = homeCheck(point, state.me.home, cfg);
    await setDoc(doc(db, "checkins", `${key}_${state.user.uid}_${name}`), {
      uid: state.user.uid,
      name: state.me.name,
      date: key,
      session: name,
      timestamp: serverTimestamp(),
      location: point,
      distanceFromHome: hc.distance,
      homeStatus: hc.status,
      late: !!w.late,
    });
  } catch (ex) {
    showTeacherError(geoMessage(ex));
  } finally {
    renderTeacher();
  }
});

// Daftar lokasi rumah
$("t-sethome").addEventListener("click", async () => {
  showTeacherError("");
  if (!confirm("Daftarkan lokasi semasa sebagai rumah anda? Anda tidak boleh mengubahnya sendiri selepas ini.")) return;
  const btn = $("t-sethome");
  btn.disabled = true;
  btn.textContent = "Mengesan lokasi…";
  try {
    const pos = await getPosition();
    const accuracy = Math.round(pos.coords.accuracy);
    if (accuracy > 100) {
      throw { message: `Ketepatan GPS terlalu rendah (±${accuracy} m). Hidupkan GPS, dekati tingkap atau pintu, dan cuba lagi.` };
    }
    await updateDoc(doc(db, "teachers", state.user.uid), {
      home: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy, setAt: Date.now() },
    });
  } catch (ex) {
    showTeacherError(geoMessage(ex));
  } finally {
    btn.disabled = false;
    btn.textContent = "Daftar Lokasi Rumah Sekarang";
  }
});

/* =====================================================
   DASHBOARD PENTADBIR
   ===================================================== */
let map = null;
const markers = new Map();
let fitSig = "";

function startAdmin() {
  show("admin");
  const cfg = state.config;
  $("a-school").textContent = cfg.name || "Sekolah";
  $("a-name").textContent = state.me.name;
  state.date = dateKey(cfg.timezone);
  $("f-date").value = state.date;

  initMap();
  initAdminTools(state);

  state.unsubs.push(
    onSnapshot(
      collection(db, "teachers"),
      (snap) => {
        state.teachers = snap.docs
          .map((d) => ({ id: d.id, ...d.data(SNAP) }))
          .filter((t) => t.role !== "admin" && t.active !== false)
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderAdmin();
      },
      (err) => console.error("Firestore:", err)
    )
  );
  subscribeCheckins();

  state.timers.push(setInterval(renderAdmin, 30000));
  state.timers.push(setInterval(() => ($("a-clock").textContent = clock(cfg.timezone)), 1000));
}

function subscribeCheckins() {
  ciUnsub?.();
  ciUnsub = onSnapshot(
    query(collection(db, "checkins"), where("date", "==", state.date)),
    (snap) => {
      state.checkins = snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
      renderAdmin();
    },
    (err) => console.error("Firestore:", err)
  );
}

["f-q", "f-session", "f-status"].forEach((id) => $(id).addEventListener("input", () => renderAdmin()));
$("f-date").addEventListener("change", (e) => {
  if (!e.target.value) return;
  state.date = e.target.value;
  fitSig = "";
  subscribeCheckins();
});

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 100); return; }
  const c = state.config.center;
  map = L.map("map").setView([c.lat, c.lng], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
  setTimeout(() => map.invalidateSize(), 100);
}

function buildSlots() {
  const cfg = state.config;
  const today = dateKey(cfg.timezone);
  const day = weekdayOfKey(state.date);
  if (day === 0 || day === 6) return [];

  const byKey = new Map(state.checkins.map((c) => [`${c.uid}_${c.session}`, c]));
  const slots = [];
  for (const t of state.teachers) {
    for (const session of sessionsOf(t.session)) {
      const ci = byKey.get(`${t.id}_${session}`);
      let status;
      if (ci) {
        status = isLateAt(ci.timestamp.toDate(), session, cfg) ? "lewat" : "hadir";
      } else if (state.date < today) {
        status = "tidak-hadir";
      } else if (state.date === today) {
        const end = cfg.sessions[session].end.split(":").map(Number);
        status = minutesNow(cfg.timezone) >= end[0] * 60 + end[1] ? "tidak-hadir" : "belum";
      } else {
        status = "belum";
      }
      slots.push({ key: `${t.id}_${session}`, t, session, ci, status, luar: ci?.homeStatus === "luar" });
    }
  }
  return slots;
}

function statCard(label, value, color) {
  return `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
    <p class="text-xs text-slate-500">${label}</p><p class="mt-1 text-2xl font-bold ${color}">${value}</p></div>`;
}

let lastList = [];

function renderAdmin() {
  const cfg = state.config;
  const slots = buildSlots();
  const weekend = [0, 6].includes(weekdayOfKey(state.date));

  const n = (fn) => slots.filter(fn).length;
  $("a-stats").innerHTML =
    statCard("Jumlah Slot", slots.length, "text-slate-800") +
    statCard("Hadir", n((s) => s.status === "hadir"), "text-green-600") +
    statCard("Lewat", n((s) => s.status === "lewat"), "text-amber-600") +
    statCard("Belum", n((s) => s.status === "belum"), "text-sky-600") +
    statCard("Tidak Hadir", n((s) => s.status === "tidak-hadir"), "text-red-600") +
    statCard("Luar Lokasi", n((s) => s.luar), "text-red-600");

  const q = $("f-q").value.trim().toLowerCase();
  const fs = $("f-session").value;
  const fst = $("f-status").value;
  const list = slots.filter(
    (s) =>
      (!q || (s.t.name || "").toLowerCase().includes(q)) &&
      (!fs || s.session === fs) &&
      (!fst || (fst === "luar-lokasi" ? s.luar : s.status === fst))
  );
  lastList = list;

  $("a-count").textContent = `${list.length} / ${slots.length} slot`;
  $("a-empty").textContent = weekend ? "Hujung minggu: tiada check-in diperlukan." : "Tiada rekod sepadan.";
  $("a-empty").classList.toggle("hidden", list.length > 0);
  $("a-rows").innerHTML = list
    .map((s) => {
      const st = SLOT[s.status];
      return `<tr data-key="${esc(s.key)}" class="cursor-pointer hover:bg-slate-50">
        <td class="px-4 py-3"><p class="font-medium">${esc(s.t.name)}</p>
          <p class="text-xs text-slate-500">${SESSION_LABEL[s.session]}${s.t.home ? "" : " &middot; <span class='text-amber-600'>Rumah belum didaftar</span>"}</p></td>
        <td class="px-2 py-3"><span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.badge}">${st.label}</span>
          ${s.luar ? `<span class="ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold bg-red-100 text-red-700">Luar lokasi</span>` : ""}</td>
        <td class="px-4 py-3 text-right text-xs text-slate-500 whitespace-nowrap">${s.ci ? esc(timeOf(s.ci.timestamp, cfg.timezone)) : "–"}</td></tr>`;
    })
    .join("");

  // Peta: lokasi check-in
  const visible = new Set();
  for (const s of list) {
    if (!s.ci?.location) continue;
    visible.add(s.key);
    const pos = [s.ci.location.lat, s.ci.location.lng];
    const popup = `<b>${esc(s.t.name)}</b><br>${SESSION_LABEL[s.session]} &middot; ${SLOT[s.status].label} (${esc(timeOf(s.ci.timestamp, cfg.timezone))})<br><small>${s.luar ? "Luar lokasi rumah" : "Di rumah"} &middot; ${esc(s.ci.distanceFromHome)} m dari rumah &middot; ±${esc(s.ci.location.accuracy)} m</small>`;
    let m = markers.get(s.key);
    if (!m) {
      m = L.circleMarker(pos, { radius: 9, weight: 3, color: s.luar ? "#dc2626" : "#fff", fillOpacity: 0.95 }).addTo(map);
      m.bindPopup(popup);
      markers.set(s.key, m);
    } else {
      m.setLatLng(pos);
      m.setPopupContent(popup);
    }
    m.setStyle({ fillColor: SLOT[s.status].color, color: s.luar ? "#dc2626" : "#fff" });
  }
  for (const [k, m] of markers) if (!visible.has(k)) { m.remove(); markers.delete(k); }

  const sig = [...visible].sort().join("|");
  if (sig && sig !== fitSig) {
    fitSig = sig;
    map.fitBounds(L.featureGroup([...markers.values()]).getBounds().pad(0.2), { maxZoom: 16 });
  }
}

$("a-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-key]");
  const m = tr && markers.get(tr.dataset.key);
  if (!m) return;
  map.flyTo(m.getLatLng(), 17);
  m.openPopup();
  $("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// Eksport CSV (senarai yang sedang ditapis)
$("btn-export").addEventListener("click", () => {
  const cfg = state.config;
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // elak formula injection dalam Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Tarikh", "Nama", "Sesi", "Status", "Masa Check-in", "Jarak dari Rumah (m)", "Lokasi Rumah"];
  const lines = lastList.map((s) =>
    [
      state.date, s.t.name, SESSION_LABEL[s.session], SLOT[s.status].label,
      s.ci ? timeOf(s.ci.timestamp, cfg.timezone) : "",
      s.ci ? s.ci.distanceFromHome : "",
      s.ci ? (s.luar ? "Luar" : "Dalam") : "",
    ].map(cell).join(",")
  );
  const blob = new Blob(["﻿" + [head.map(cell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kehadiran-guru-${state.date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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
