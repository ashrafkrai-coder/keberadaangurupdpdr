/**
 * Perkhidmatan geofence dengan ketepatan adaptif.
 *
 *  - NATIVE (Android/iOS via Capacitor): @capacitor-community/background-geolocation.
 *    GPS kekal berfungsi apabila skrin ditutup (notifikasi kekal di Android).
 *  - BROWSER: sandaran navigator.geolocation.watchPosition (tertakluk had pelayar;
 *    app mesti kekal terbuka).
 *
 * Mod bateri:  JAUH (> 500 m dari semua sasaran) -> distanceFilter 100 m (jimat bateri)
 *              DEKAT (<= 500 m dari mana-mana)   -> distanceFilter 10 m  (ketepatan tinggi)
 *
 * Fail ini dimuat terus sebagai modul ES (tiada langkah bundler), jadi pemalam native
 * dicapai melalui Capacitor.registerPlugin(), bukan import npm.
 */

const NEAR_THRESHOLD_M = 500;
const FILTER_FAR = 100;
const FILTER_NEAR = 10;
const MAX_TOLERANCE_M = 100; // tambahan radius maksimum untuk ketepatan GPS yang lemah

/* ---------------- Pengesanan platform ---------------- */
export function isNativePlatform() {
  return !!(typeof window !== "undefined" && window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

let bgPlugin = null;
function getBackgroundGeolocation() {
  if (!bgPlugin) bgPlugin = window.Capacitor.registerPlugin("BackgroundGeolocation");
  return bgPlugin;
}

/* ---------------- Formula Haversine ---------------- */
export function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // jejari bumi (meter)
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isInsideGeofence(userLat, userLng, fenceLat, fenceLng, radiusMeters) {
  return getDistanceInMeters(userLat, userLng, fenceLat, fenceLng) <= radiusMeters;
}

/* ---------------- Keadaan tracker ---------------- */
let session = null; // { targets, onChange, onError, mode, watcherId, watchId, status:Map, switching, stopped }

export function isTracking() {
  return session !== null && !session.stopped;
}

/**
 * Mula penjejakan geofence.
 * @param {{id:string, lat:number, lng:number, radiusMeters:number}[]} geofenceTargets
 * @param {(e:{inside:boolean, geofenceId:string, location:object, distance:number}) => void} onZoneStatusChange
 * @param {(msg:string, code?:string) => void} [onError]
 * @returns {Promise<void>}
 */
export async function startGeofenceTracking(geofenceTargets, onZoneStatusChange, onError = console.error) {
  if (session && !session.stopped) await stopGeofenceTracking();
  session = {
    targets: geofenceTargets,
    onChange: onZoneStatusChange,
    onError,
    mode: null,
    watcherId: null,
    watchId: null,
    status: new Map(), // geofenceId -> boolean (dalam/luar)
    switching: false,
    stopped: false,
  };
  await startWatch(session, FILTER_FAR); // bermula dalam mod jimat; beralih sendiri selepas fix pertama
}

/** Henti penjejakan: buang watcher, GPS dan notifikasi kekal dimatikan. */
export async function stopGeofenceTracking() {
  const s = session;
  if (!s) return;
  s.stopped = true;
  session = null;
  await stopWatch(s);
}

/* ---------------- Watcher: native vs sandaran ---------------- */
async function startWatch(s, distanceFilter) {
  s.mode = distanceFilter;

  if (isNativePlatform()) {
    const BG = getBackgroundGeolocation();
    s.watcherId = await BG.addWatcher(
      {
        backgroundTitle: "Penjejakan Geofence Aktif",
        backgroundMessage: "Aplikasi sedang mengesan zon lokasi di latar belakang.",
        requestPermissions: true,
        stale: false,
        distanceFilter,
      },
      (location, error) => {
        if (s.stopped) return;
        if (error) {
          if (error.code === "NOT_AUTHORIZED") {
            s.onError("Kebenaran lokasi diperlukan. Pilih 'Sentiasa benarkan' dalam tetapan app.", error.code);
            BG.openSettings().catch(() => {});
          } else {
            s.onError(error.message || "Ralat lokasi.", error.code);
          }
          return;
        }
        if (location) handleLocation(s, { lat: location.latitude, lng: location.longitude, accuracy: location.accuracy, simulated: !!location.simulated, time: location.time });
      }
    );
    return;
  }

  // Sandaran pelayar. enableHighAccuracy meniru mod dekat/jauh (distanceFilter tiada dalam pelayar).
  if (!("geolocation" in navigator)) {
    s.onError("Peranti ini tidak menyokong Geolocation.", "UNSUPPORTED");
    return;
  }
  s.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (s.stopped) return;
      handleLocation(s, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, simulated: false, time: pos.timestamp });
    },
    (err) => {
      if (s.stopped) return;
      s.onError(
        err.code === 1 ? "Kebenaran lokasi ditolak. Aktifkan lokasi untuk app ini." : "Lokasi tidak dapat ditentukan.",
        err.code === 1 ? "NOT_AUTHORIZED" : "POSITION_UNAVAILABLE"
      );
    },
    { enableHighAccuracy: distanceFilter === FILTER_NEAR, maximumAge: 15000, timeout: 30000 }
  );
}

async function stopWatch(s) {
  try {
    if (s.watcherId !== null && isNativePlatform()) {
      await getBackgroundGeolocation().removeWatcher({ id: s.watcherId });
    }
    if (s.watchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(s.watchId);
  } catch (e) {
    console.warn("stopWatch:", e);
  }
  s.watcherId = null;
  s.watchId = null;
}

/* ---------------- Penilaian lokasi ---------------- */
async function handleLocation(s, loc) {
  if (loc.simulated) return; // abaikan lokasi palsu (mock location)

  const tolerance = Math.min(loc.accuracy || 0, MAX_TOLERANCE_M);
  let minDistance = Infinity;

  for (const t of s.targets) {
    const distance = getDistanceInMeters(loc.lat, loc.lng, t.lat, t.lng);
    minDistance = Math.min(minDistance, distance);

    const inside = isInsideGeofence(loc.lat, loc.lng, t.lat, t.lng, t.radiusMeters + tolerance);
    if (s.status.get(t.id) !== inside) {
      s.status.set(t.id, inside);
      try {
        s.onChange({ inside, geofenceId: t.id, location: loc, distance: Math.round(distance) });
      } catch (e) {
        console.error("onZoneStatusChange:", e);
      }
    }
  }

  // Tukar mod ketepatan jika perlu
  const wanted = minDistance <= NEAR_THRESHOLD_M ? FILTER_NEAR : FILTER_FAR;
  if (wanted !== s.mode && !s.switching && !s.stopped) {
    s.switching = true;
    try {
      await stopWatch(s);
      if (!s.stopped) await startWatch(s, wanted);
    } finally {
      s.switching = false;
    }
  }
}
