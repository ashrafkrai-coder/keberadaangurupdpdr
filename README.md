# Keberadaan Guru PdPR

PWA untuk guru check-in keberadaan dari rumah semasa Pembelajaran dari Rumah.
Tech stack: HTML + Tailwind (CDN) + JavaScript ES modules, Firebase (Auth, Firestore, Hosting), Leaflet.

## Cara kerja
- Guru daftar **lokasi rumah** sekali, kemudian **check-in** sekali setiap sesi (pagi 7.30–2.00, petang 1.00–6.40).
- Check-in dibuka 60 min sebelum sesi. Selepas waktu mula ditanda **Lewat**; jika jauh dari rumah ditanda **Luar lokasi**.
- Pentadbir melihat kehadiran mengikut tarikh, peta, dan boleh eksport CSV.
- Tiada penjejakan berterusan; lokasi hanya direkod semasa check-in.

## Persediaan (sekali sahaja)

1. **Firebase Console** → cipta projek → daftar Web App → salin `firebaseConfig` ke `public/js/firebase-init.js`.
2. **Authentication** → Sign-in method → aktifkan *Email/Password*. Tambah akaun pentadbir (Users → Add user) dan salin UID.
3. **Firestore Database** → Create database (production, `asia-southeast1`).
4. Cipta dokumen `teachers/{UID_admin}`:
   ```json
   { "name": "Pengetua", "email": "admin@sekolah.edu.my", "role": "admin", "active": true }
   ```
5. Cipta dokumen `config/school` (atau isi kemudian melalui butang **Tetapan**):
   ```json
   {
     "name": "Nama Sekolah",
     "center": { "lat": 3.139, "lng": 101.6869 },
     "homeRadiusMeters": 150,
     "timezone": "Asia/Kuala_Lumpur",
     "checkinOpenBeforeMin": 60,
     "graceMinutes": 0,
     "sessions": {
       "pagi":   { "start": "07:30", "end": "14:00" },
       "petang": { "start": "13:00", "end": "18:40" }
     }
   }
   ```
6. Pasang alat dan deploy:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add
   firebase deploy --only firestore,hosting
   ```
   Indeks gabungan untuk `checkins` dibina semasa deploy (beberapa minit).
7. Log masuk sebagai pentadbir → **Urus Guru** → tambah guru (nama, e-mel, kata laluan awal, sesi).
8. Guru buka URL (`https://<projek>.web.app`), pasang ke skrin utama, log masuk, daftar lokasi rumah, dan check-in.

## Ujian tempatan
```bash
firebase emulators:start --only hosting   # http://localhost:5000
```
Geolocation hanya berfungsi di HTTPS atau localhost. Di luar waktu check-in atau pada hujung minggu, butang check-in tidak dipaparkan; ubah sementara jadual dalam **Tetapan** untuk menguji.

## Kemas kini
Naikkan `VERSION` dalam `public/service-worker.js` setiap kali fail app diubah, kemudian `firebase deploy --only hosting`.

## Keselamatan
- Peraturan Firestore (`firestore.rules`): guru hanya boleh membuat satu rekod check-in bagi setiap sesi setiap hari, tidak boleh mengubah/memadam, dan hanya boleh mendaftar lokasi rumah sekali.
- Lokasi dihantar oleh peranti guru; guru yang mahir teknikal boleh memalsukannya. Sesuai untuk kegunaan dalaman, bukan pengesahan mutlak.
- Peta pentadbir menunjukkan lokasi rumah guru. Maklumkan guru dan hadkan akses pentadbir.
