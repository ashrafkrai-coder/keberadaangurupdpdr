import {
  doc, updateDoc, addDoc, collection, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { checkDuty, geofenceOf, statusFrom } from "./session.js";

const HISTORY_DAYS = 30;

export class LocationTracker {
  /**
   * @param {object} opts
   * @param {string} opts.uid
   * @param {"pagi"|"petang"|"kedua-dua"} opts.session
   * @param {object} opts.config      dokumen config/school
   * @param {number} [opts.intervalMs] selang tulis ke Firestore (lalai 5 min)
   * @param {(state:object)=>void} [opts.onUpdate] panggilan balik untuk UI
   * @param {(msg:string)=>void} [opts.onError]
   */
  constructor(opts) {
    this.uid = opts.uid;
    this.session = opts.session;
    this.config = opts.config;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.onUpdate = opts.onUpdate ?? (() => {});
    this.onError = opts.onError ?? console.error;

    this.watchId = null;
    this.writeTimer = null;
    this.dutyTimer = null;
    this.wakeLock = null;
    this.latest = null;        // fix GPS terkini
    this.lastGeofence = null;
    this.running = false;
  }

  get teacherRef() { return doc(db, "teachers", this.uid); }

  // ---------- Kawalan utama ----------
  async start() {
    if (this.running) return;
    if (!("geolocation" in navigator)) {
      this.onError("Peranti ini tidak menyokong Geolocation.");
      return;
    }
    const duty = checkDuty(this.session, this.config);
    if (!duty.active) {
      this.onError(`Tidak boleh mula: ${duty.label}.`);
      return;
    }

    this.running = true;
    this.lastGeofence = null;
    await updateDoc(this.teacherRef, { sharing: true, source: "pwa" });

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.#onPosition(pos),
      (err) => this.#onGeoError(err),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
    );

    // Tulis berkala (walaupun posisi tidak berubah, sebagai "denyutan")
    this.writeTimer = setInterval(() => this.#flush("berkala"), this.intervalMs);
    // Semak tamat waktu bertugas setiap 30 saat
    this.dutyTimer = setInterval(() => this.#checkDutyEnd(), 30000);

    await this.#acquireWakeLock();
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.onUpdate({ running: true, duty });
  }

  async stop(reason = "manual") {
    if (!this.running) return;
    this.running = false;

    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.writeTimer);
    clearInterval(this.dutyTimer);
    this.watchId = this.writeTimer = this.dutyTimer = null;
    document.removeEventListener("visibilitychange", this.#onVisibility);
    await this.#releaseWakeLock();

    const duty = checkDuty(this.session, this.config);
    await updateDoc(this.teacherRef, {
      sharing: false,
      status: duty.active ? "offline" : "tidak-bertugas",
      lastUpdate: serverTimestamp(),
    });
    this.onUpdate({ running: false, reason });
  }

  // ---------- Dalaman ----------
  #onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    this.latest = { lat, lng, accuracy: Math.round(accuracy) };

    const gf = geofenceOf(this.latest, this.config);
    this.onUpdate({ running: true, location: this.latest, geofence: gf });

    // Tulis serta-merta pada fix pertama atau bila status geofence berubah
    if (this.lastGeofence === null || gf !== this.lastGeofence) {
      this.lastGeofence = gf;
      this.#flush("geofence");
    }
  }

  #onGeoError(err) {
    const msg = {
      1: "Kebenaran lokasi ditolak. Aktifkan lokasi untuk app ini dalam tetapan.",
      2: "Lokasi tidak dapat ditentukan. Cuba di kawasan terbuka.",
      3: "Masa menunggu GPS tamat. Cuba lagi.",
    }[err.code] ?? err.message;
    this.onError(msg);
    if (err.code === 1) this.stop("kebenaran-ditolak");
  }

  async #flush(trigger) {
    if (!this.running || !this.latest) return;
    const duty = checkDuty(this.session, this.config);
    if (!duty.active) return this.stop("tamat-waktu");

    const geofence = geofenceOf(this.latest, this.config);
    const status = statusFrom(geofence, duty);
    const battery = await this.#battery();

    try {
      await updateDoc(this.teacherRef, {
        lastLocation: this.latest,
        lastUpdate: serverTimestamp(),
        geofence,
        status,
        source: "pwa",
        ...(battery !== null && { battery }),
      });
      await addDoc(collection(db, "teachers", this.uid, "history"), {
        ...this.latest,
        geofence,
        session: duty.window,
        source: "pwa",
        timestamp: serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + HISTORY_DAYS * 86400000),
      });
      this.onUpdate({ running: true, location: this.latest, geofence, status, trigger });
    } catch (e) {
      this.onError("Gagal hantar ke pelayan: " + e.message);
    }
  }

  #checkDutyEnd() {
    if (!checkDuty(this.session, this.config).active) this.stop("tamat-waktu");
  }

  // Bila app kembali kelihatan (selepas skrin dikunci), pulihkan dan hantar serta-merta
  #onVisibility = async () => {
    if (document.visibilityState === "visible" && this.running) {
      await this.#acquireWakeLock();
      this.#flush("kembali-aktif");
    }
  };

  async #acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
      }
    } catch { /* tidak disokong / ditolak: abaikan */ }
  }

  async #releaseWakeLock() {
    try { await this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
  }

  async #battery() {
    try {
      if (!navigator.getBattery) return null; // Chrome Android sahaja
      const b = await navigator.getBattery();
      return Math.round(b.level * 100);
    } catch { return null; }
  }
}
