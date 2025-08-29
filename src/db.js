// src/db.js
import { db } from "./firebase";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";

// Store everything in one doc: collection "gameport", doc "store"
const STORE_DOC = doc(db, "gameport", "store");

export async function loadStoreOnce() {
  const snap = await getDoc(STORE_DOC);
  return snap.exists() ? snap.data() : { tournaments: [], deleted: [] };
}

export async function saveStore(data) {
  // data: { tournaments: [...], deleted: [...] }
  await setDoc(STORE_DOC, data, { merge: false });
}

export function subscribeStore(cb) {
  // Optional realtime sync; cb gets { tournaments, deleted }
  return onSnapshot(STORE_DOC, (snap) => {
    if (snap.exists()) cb(snap.data());
  });
}
