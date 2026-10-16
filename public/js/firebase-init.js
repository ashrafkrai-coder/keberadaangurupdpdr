import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// TAMPAL firebaseConfig anda (Firebase Console > Project settings > Your apps)
const firebaseConfig = {
  apiKey: "GANTI",
  authDomain: "keberadaan-guru.firebaseapp.com",
  projectId: "keberadaan-guru",
  storageBucket: "keberadaan-guru.appspot.com",
  messagingSenderId: "GANTI",
  appId: "GANTI",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
