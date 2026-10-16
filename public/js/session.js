// Jadual lalai; nilai sebenar dibaca dari config/school di Firestore
export const DEFAULT_CONFIG = {
  center: { lat: 3.1390, lng: 101.6869 },
  radiusMeters: 300,
  timezone: "Asia/Kuala_Lumpur",
  sessions: {
    pagi:   { start: "07:30", end: "14:00" },
    petang: { start: "13:00", end: "18:40" },
  },
  staleAfterMinutes: 10,
};

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Minit sejak tengah malam mengikut zon waktu sekolah (bukan zon peranti). */
export function minutesNow(tz = "Asia/Kuala_Lumpur", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

/** 0 = Ahad ... 6 = Sabtu mengikut zon waktu sekolah. */
export function weekdayNow(tz = "Asia/Kuala_Lumpur", date = new Date()) {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

/**
 * Adakah guru dalam waktu bertugas sekarang?
 * @param {"pagi"|"petang"|"kedua-dua"} teacherSession
 * @returns {{active:boolean, window:"pagi"|"petang"|null, label:string}}
 */
export function checkDuty(teacherSession, config = DEFAULT_CONFIG, date = new Date()) {
  const tz = config.timezone || "Asia/Kuala_Lumpur";
  const day = weekdayNow(tz, date);
  if (day === 0 || day === 6) {
    return { active: false, window: null, label: "Hujung minggu" };
  }
  const now = minutesNow(tz, date);
  const names = teacherSession === "kedua-dua" ? ["pagi", "petang"] : [teacherSession];

  for (const name of names) {
    const s = config.sessions[name];
    if (s && now >= toMin(s.start) && now < toMin(s.end)) {
      return { active: true, window: name, label: `Sesi ${name}` };
    }
  }
  return { active: false, window: null, label: "Di luar waktu bertugas" };
}

/** Jarak (meter) antara dua koordinat: formula Haversine. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function geofenceOf(point, config = DEFAULT_CONFIG) {
  return distanceMeters(point, config.center) <= config.radiusMeters ? "dalam" : "luar";
}

/** Status yang dihantar bersama lokasi. */
export function statusFrom(geofence, duty) {
  if (!duty.active) return "tidak-bertugas";
  return geofence === "dalam" ? "online" : "luar-zon";
}

/**
 * Status sebenar untuk dipaparkan di dashboard (tanpa Cloud Function).
 * @param teacher dokumen dari koleksi teachers (lastUpdate = Firestore Timestamp)
 */
export function effectiveStatus(teacher, config = DEFAULT_CONFIG, date = new Date()) {
  const duty = checkDuty(teacher.session, config, date);
  if (!duty.active) return "tidak-bertugas";

  const last = teacher.lastUpdate?.toMillis?.() ?? 0;
  const staleMs = (config.staleAfterMinutes ?? 10) * 60000;
  if (!teacher.sharing || !last || date.getTime() - last > staleMs) return "offline";

  return teacher.status; // "online" | "luar-zon"
}
