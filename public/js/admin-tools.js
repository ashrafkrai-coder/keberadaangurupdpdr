import { app, db } from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteField, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SESSIONS = [["pagi", "Pagi"], ["petang", "Petang"], ["kedua-dua", "Pagi & Petang"]];
let wired = false;
let unsub = null;

export function initAdminTools(state) {
  if (wired) return;
  wired = true;

  /* ---------- Urus Guru ---------- */
  $("btn-manage").addEventListener("click", () => {
    $("dlg-teachers").showModal();
    unsub?.();
    unsub = onSnapshot(collection(db, "teachers"), (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((t) => t.role !== "admin")
        .sort((a, b) => (b.pending === true && b.active === false) - (a.pending === true && a.active === false) ||
          (a.name || "").localeCompare(b.name || ""));
      $("m-rows").innerHTML = rows
        .map(
          (t) => `<tr data-uid="${esc(t.id)}">
            <td class="px-3 py-2"><p class="font-medium">${esc(t.name)}${t.pending === true && t.active === false ? ' <span class="ml-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-semibold">Menunggu kelulusan</span>' : ""}</p><p class="text-xs text-slate-500">${esc(t.email)}</p></td>
            <td class="px-3 py-2"><select data-f="session" class="rounded-lg border border-slate-300 px-2 py-1 bg-white text-sm">
              ${SESSIONS.map(([v, l]) => `<option value="${v}" ${t.session === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
            <td class="px-3 py-2 text-center text-xs">${t.home ? `<span class="text-green-600">Berdaftar</span> <button data-reset-home class="ml-1 text-red-600 underline">Reset</button>` : `<span class="text-slate-400">Belum</span>`}</td>
            <td class="px-3 py-2 text-center"><input data-f="active" type="checkbox" class="h-4 w-4" ${t.active !== false ? "checked" : ""} /></td></tr>`
        )
        .join("");
      $("m-empty").classList.toggle("hidden", rows.length > 0);
    });
  });

  $("dlg-teachers").addEventListener("close", () => { unsub?.(); unsub = null; });

  $("m-rows").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-reset-home]");
    const tr = btn && btn.closest("tr[data-uid]");
    if (!tr) return;
    if (!confirm("Reset lokasi rumah guru ini? Guru perlu mendaftar semula.")) return;
    try {
      await updateDoc(doc(db, "teachers", tr.dataset.uid), { home: deleteField() });
    } catch (ex) {
      alert("Gagal reset: " + ex.message);
    }
  });

  $("m-rows").addEventListener("change", async (e) => {
    const tr = e.target.closest("tr[data-uid]");
    const f = e.target.dataset.f;
    if (!tr || !f) return;
    const value = f === "active" ? e.target.checked : e.target.value;
    try {
      // Meluluskan (atau menyahaktifkan) menamatkan status "menunggu kelulusan"
      await updateDoc(doc(db, "teachers", tr.dataset.uid), f === "active" ? { active: value, pending: false } : { [f]: value });
    } catch (ex) {
      alert("Gagal menyimpan: " + ex.message);
    }
  });

  $("m-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("m-msg");
    const btn = $("m-add-btn");
    msg.className = "hidden";
    btn.disabled = true;

    const name = $("m-name").value.trim();
    const email = $("m-email").value.trim();
    const password = $("m-pass").value;
    const session = $("m-session").value;

    // Aplikasi sekunder supaya sesi pentadbir tidak terkeluar semasa akaun baharu dicipta
    const secondary = initializeApp(app.options, "secondary-" + Date.now());
    let uid = null;
    try {
      const sAuth = getAuth(secondary);
      uid = (await createUserWithEmailAndPassword(sAuth, email, password)).user.uid;
      await signOut(sAuth);

      await setDoc(doc(db, "teachers", uid), {
        name, email, role: "guru", session, active: true,
        sharing: false, status: "offline", geofence: "tidak-diketahui",
        createdAt: serverTimestamp(),
      });
      $("m-add").reset();
      note(msg, `Guru ${name} berjaya ditambah.`, true);
    } catch (ex) {
      const map = {
        "auth/email-already-in-use": "E-mel ini sudah didaftarkan.",
        "auth/weak-password": "Kata laluan terlalu lemah (minimum 6 aksara).",
        "auth/invalid-email": "Format e-mel tidak sah.",
      };
      note(msg, map[ex.code] || "Gagal: " + ex.message + (uid ? " (akaun log masuk telah dicipta; cuba tambah semula atau cipta dokumen secara manual)" : ""), false);
    } finally {
      await deleteApp(secondary).catch(() => {});
      btn.disabled = false;
    }
  });

  /* ---------- Tetapan Sekolah ---------- */
  $("btn-settings").addEventListener("click", () => {
    const c = state.config;
    $("s-name").value = c.name || "";
    $("s-lat").value = c.center.lat;
    $("s-lng").value = c.center.lng;
    $("s-radius").value = c.homeRadiusMeters;
    $("s-open").value = c.checkinOpenBeforeMin;
    $("s-grace").value = c.graceMinutes;
    $("s-pagi-start").value = c.sessions.pagi.start;
    $("s-pagi-end").value = c.sessions.pagi.end;
    $("s-petang-start").value = c.sessions.petang.start;
    $("s-petang-end").value = c.sessions.petang.end;
    $("s-msg").className = "hidden";
    $("dlg-settings").showModal();
  });

  $("s-here").addEventListener("click", () => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        $("s-lat").value = p.coords.latitude.toFixed(6);
        $("s-lng").value = p.coords.longitude.toFixed(6);
      },
      () => note($("s-msg"), "Tidak dapat mengambil lokasi. Benarkan akses lokasi.", false),
      { enableHighAccuracy: true, timeout: 20000 }
    );
  });

  $("s-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("s-msg");
    const data = {
      name: $("s-name").value.trim(),
      center: { lat: parseFloat($("s-lat").value), lng: parseFloat($("s-lng").value) },
      homeRadiusMeters: parseInt($("s-radius").value, 10),
      checkinOpenBeforeMin: parseInt($("s-open").value, 10),
      graceMinutes: parseInt($("s-grace").value, 10),
      timezone: state.config.timezone || "Asia/Kuala_Lumpur",
      sessions: {
        pagi: { start: $("s-pagi-start").value, end: $("s-pagi-end").value },
        petang: { start: $("s-petang-start").value, end: $("s-petang-end").value },
      },
    };
    if (!isFinite(data.center.lat) || !isFinite(data.center.lng) || !(data.homeRadiusMeters > 0)) {
      return note(msg, "Semak koordinat dan radius.", false);
    }
    try {
      await setDoc(doc(db, "config", "school"), data, { merge: true });
      note(msg, "Disimpan. Memuat semula…", true);
      setTimeout(() => location.reload(), 800);
    } catch (ex) {
      note(msg, "Gagal menyimpan: " + ex.message, false);
    }
  });

  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => b.closest("dialog").close())
  );
}

function note(el, text, ok) {
  el.textContent = text;
  el.className = `text-sm rounded-lg px-3 py-2 ${ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`;
}
