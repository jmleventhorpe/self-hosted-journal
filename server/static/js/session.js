// Talking to the server while logged in, and getting logged back in when
// the session ends - without leaving the page or losing what's on it.

import { setStatus } from "./status.js";

const appRoot = document.getElementById("app-root");
const unlockOverlay = document.getElementById("unlock-overlay");
const unlockForm = document.getElementById("unlock-form");
const unlockPassword = document.getElementById("unlock-password");
const unlockError = document.getElementById("unlock-error");
const unlockSubmit = unlockForm.querySelector("button[type=submit]");
let unlockPromise = null;
let resolveUnlock = null;

// A 401 means the server forgot this session (e.g. it restarted - keys
// live only in its memory). Rather than navigating away and losing
// whatever is in the editor, ask for the password in place, then retry
// the request. Concurrent 401s share the one prompt.
export async function api(path, options) {
  for (;;) {
    const res = await fetch(path, options);
    if (res.status !== 401) return res;
    await promptUnlock();
  }
}

export function promptUnlock() {
  if (!unlockPromise) {
    unlockPromise = new Promise((resolve) => { resolveUnlock = resolve; });
    unlockError.textContent = "";
    unlockPassword.value = "";
    unlockOverlay.hidden = false;
    unlockPassword.focus();
    setStatus("Session expired - unlock to keep saving.", 0, true);
  }
  return unlockPromise;
}

export function isUnlockOpen() {
  return !unlockOverlay.hidden;
}

// Lock the page when the login runs out (a hard limit set by the server),
// rather than leaving the entry on screen until the next save happens to
// be refused. Timers can fire late after the computer sleeps, so coming
// back to the tab checks too.
let lockAt = Infinity;
let lockTimer = null;

export function scheduleLock(seconds) {
  clearTimeout(lockTimer);
  lockAt = Date.now() + seconds * 1000;
  lockTimer = setTimeout(promptUnlock, seconds * 1000);
}

scheduleLock(Number(appRoot.dataset.sessionExpiresIn));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() >= lockAt) promptUnlock();
});

unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockError.textContent = "";
  unlockSubmit.disabled = true;
  unlockSubmit.textContent = "Unlocking…";
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: unlockPassword.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      unlockError.textContent = data.error || "Something went wrong.";
      return;
    }
    scheduleLock(data.expires_in);
    unlockOverlay.hidden = true;
    unlockPassword.value = "";
    setStatus("");
    const resolve = resolveUnlock;
    unlockPromise = null;
    resolveUnlock = null;
    resolve();
  } catch (err) {
    unlockError.textContent = "Couldn't reach the server - check your connection.";
  } finally {
    unlockSubmit.disabled = false;
    unlockSubmit.textContent = "Unlock";
  }
});
