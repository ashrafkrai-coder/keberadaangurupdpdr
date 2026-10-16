// Nilai lalai; nilai sebenar dibaca dari config/school di Firestore
export const DEFAULT_CONFIG = {
  name: "Sekolah",
  center: { lat: 3.1390, lng: 101.6869 }, // hanya untuk paparan lalai peta
  homeRadiusMeters: 150,                  // jarak maksimum dari rumah berdaftar
  timezone: "Asia/Kuala_Lumpur",
  checkinOpenBeforeMin: 60,               // check-in dibuka sekian minit sebelum sesi
  graceMinutes: 0,                        // tempoh bertolak ansur sebelum dikira lewat
  sessions: {
    pagi:   { start: "07:30", end: "14:00" },
    petang: { start: "13:00", end: "18:40" },
  },
};

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fmtMin = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

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

/** Kunci tarikh "YYYY-MM-DD" mengikut zon waktu sekolah. */
export function dateKey(tz = "Asia/Kuala_Lumpur", date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export const weekdayOfKey = (key) => new Date(key + "T00:00:00Z").getUTCDay();

export const sessionsOf = (teacherSession) =>
  teacherSession === "kedua-dua" ? ["pagi", "petang"] : [teacherSession];

/**
 * Keadaan tetingkap check-in bagi satu sesi pada masa ini.
 * @returns {{state:"cuti"|"belum-buka"|"buka"|"tutup", late?:boolean, opensAt?:string}}
 */
export function windowState(sessionName, config, date = new Date()) {
  const tz = config.timezone;
  const day = weekdayNow(tz, date);
  if (day === 0 || day === 6) return { state: "cuti" };

  const s = config.sessions[sessionName];
  const now = minutesNow(tz, date);
  const start = toMin(s.start);
  const end = toMin(s.end);
  const opens = start - (config.checkinOpenBeforeMin ?? 60);

  if (now < opens) return { state: "belum-buka", opensAt: fmtMin(opens) };
  if (now >= end) return { state: "tutup" };
  return { state: "buka", late: now > start + (config.graceMinutes ?? 0) };
}

/** Adakah check-in pada masa `date` dikira lewat untuk sesi ini? */
export function isLateAt(date, sessionName, config) {
  const s = config.sessions[sessionName];
  return minutesNow(config.timezone, date) > toMin(s.start) + (config.graceMinutes ?? 0);
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

/**
 * Bandingkan lokasi check-in dengan rumah berdaftar.
 * Ketepatan GPS (maks 100 m) ditambah pada radius supaya guru tidak
 * ditanda "luar" kerana isyarat GPS dalam rumah kurang tepat.
 */
export function homeCheck(point, home, config) {
  const d = distanceMeters(point, home);
  const tolerance = Math.min(point.accuracy ?? 0, 100);
  return {
    distance: Math.round(d),
    status: d <= (config.homeRadiusMeters ?? 150) + tolerance ? "dalam" : "luar",
  };
}
