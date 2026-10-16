import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Konfigurasi web Firebase (kunci ini memang awam; keselamatan dikawal oleh firestore.rules)
const firebaseConfig = {
  apiKey: "AIzaSyBUbsoXfsK1r_SK-GzRIWExZBIdUPNPJ4k",
  authDomain: "keberadaan-guru-pdpr.firebaseapp.com",
  projectId: "keberadaan-guru-pdpr",
  storageBucket: "keberadaan-guru-pdpr.firebasestorage.app",
  messagingSenderId: "670915574576",
  appId: "1:670915574576:web:6876f63990a4effb7ae6f5",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
