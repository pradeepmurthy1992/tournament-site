// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
// (Optional) Auth used by the component, imported there via getAuth()

// ⬇️ Your config
const firebaseConfig = {
  apiKey: "AIzaSyAzIQ9sWWL2w2_6U0NjtjfzH1ZCjQf1gik",
  authDomain: "gameport-9409a.firebaseapp.com",
  projectId: "gameport-9409a",
  storageBucket: "gameport-9409a.firebasestorage.app",
  messagingSenderId: "491060826472",
  appId: "1:491060826472:web:a09a15ff4ce741640886dd",
  measurementId: "G-16E32EKR6N"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
