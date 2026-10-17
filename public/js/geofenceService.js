/**
 * Perkhidmatan geofence untuk PWA (navigator.geolocation.watchPosition).
 *
 * Had pelayar: penjejakan terhenti apabila skrin dikunci atau app ditutup, jadi app
 * mesti kekal terbuka.
 *
 * Mod ketepatan adaptif (meniru distanceFilter dengan enableHighAccuracy):
 *   JAUH  (> 500 m dari semua sasaran) -> ketepatan biasa (jimat bateri)
 *   DEKAT (<= 500 m dari mana-mana)    -> ketepatan tinggi
 */

const NEAR_THRESHOLD_M = 500;
const MAX_TOLERANCE_M = 100; // tambahan radius maksimum untuk ketepatan GPS yang lemah

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
let session = null; // { targets, onChange, onError, highAccuracy, watchId, status:Map, stopped }

export function isTracking() {
  return session !== null && !session.stopped;
}

/**
 * Mula penjejakan geofence.
 * @param {{id:string, lat:number, lng:number, radiusMeters:number}[]} geofenceTargets
 * @param {(e:{inside:boolean, geofenceId:string, location:object, distance:number}) => void} onZoneStatusChange
 * @param {(msg:string, code?:string) => void} [onError]
 */
export async function startGeofenceTracking(geofenceTargets, onZoneStatusChange, onError = console.error) {
  if (session && !session.stopped) await stopGeofenceTracking();
  session = {
    targets: geofenceTargets,
    onChange: onZoneStatusChange,
    onError,
    highAccuracy: false,
    watchId: null,
    status: new Map(), // geofenceId -> boolean (dalam/luar)
    stopped: false,
  };
  startWatch(session);
}

/** Henti penjejakan dan lepaskan GPS. */
export async function stopGeofenceTracking() {
  const s = session;
  if (!s) return;
  s.stopped = true;
  session = null;
  stopWatch(s);
}

/* ---------------- Watcher ---------------- */
function startWatch(s) {
  if (!("geolocation" in navigator)) {
    s.onError("Peranti ini tidak menyokong Geolocation.", "UNSUPPORTED");
    return;
  }
  s.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (s.stopped) return;
      handleLocation(s, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, time: pos.timestamp });
    },
    (err) => {
      if (s.stopped) return;
      s.onError(
        err.code === 1 ? "Kebenaran lokasi ditolak. Aktifkan lokasi untuk app ini." : "Lokasi tidak dapat ditentukan.",
        err.code === 1 ? "NOT_AUTHORIZED" : "POSITION_UNAVAILABLE"
      );
    },
    { enableHighAccuracy: s.highAccuracy, maximumAge: 15000, timeout: 30000 }
  );
}

function stopWatch(s) {
  if (s.watchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(s.watchId);
  s.watchId = null;
}

/* ---------------- Penilaian lokasi ---------------- */
function handleLocation(s, loc) {
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

  // Tukar mod ketepatan jika perlu (mulakan semula watcher)
  const wantHigh = minDistance <= NEAR_THRESHOLD_M;
  if (wantHigh !== s.highAccuracy && !s.stopped) {
    s.highAccuracy = wantHigh;
    stopWatch(s);
    startWatch(s);
  }
}
