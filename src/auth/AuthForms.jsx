import React, { useState } from "react";
import { useAuth } from "./AuthContext";
import { ACCENT } from "../theme";

// Sign up / log in card. Rendered wherever a visitor needs an account —
// currently the app's landing/Dashboard tab when logged out.
export default function AuthForms({ onDone }) {
  const { signUp, signIn } = useAuth();
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signupDone, setSignupDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      if (mode === "signup") {
        await signUp(email.trim(), password, displayName.trim());
        setSignupDone(true);
      } else {
        await signIn(email.trim(), password);
        onDone?.();
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (signupDone) {
    return (
      <div className="max-w-sm mx-auto border rounded-2xl p-4 glass text-center" style={{ borderColor: ACCENT }}>
        <h3 className="font-semibold mb-2">Check your email</h3>
        <p className="text-sm text-white/80">
          We sent a confirmation link to <b>{email}</b>. Click it, then come back and log in.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto border rounded-2xl p-4 glass" style={{ borderColor: ACCENT }}>
      <div className="flex mb-4 rounded-xl border overflow-hidden" style={{ borderColor: ACCENT }}>
        <button type="button" onClick={() => setMode("login")}
          className="flex-1 py-2 text-sm font-semibold transition"
          style={{ backgroundColor: mode === "login" ? ACCENT : "transparent" }}>
          Log In
        </button>
        <button type="button" onClick={() => setMode("signup")}
          className="flex-1 py-2 text-sm font-semibold transition"
          style={{ backgroundColor: mode === "signup" ? ACCENT : "transparent" }}>
          Sign Up
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === "signup" && (
          <div>
            <label className="text-xs">Display name</label>
            <input className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: ACCENT }}
              value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g., Priya" />
          </div>
        )}
        <div>
          <label className="text-xs">Email</label>
          <input type="email" required className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: ACCENT }}
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div>
          <label className="text-xs">Password</label>
          <input type="password" required minLength={6} className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: ACCENT }}
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
        </div>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button type="submit" disabled={busy}
          className="w-full px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black disabled:opacity-50">
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
        </button>
      </form>
    </div>
  );
}
