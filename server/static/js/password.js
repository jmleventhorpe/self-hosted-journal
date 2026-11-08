// --- Change password dialog.

import { flushPendingSave, whenSaved } from "./saving.js";
import { api, scheduleLock } from "./session.js";
import { setStatus } from "./status.js";

const appRoot = document.getElementById("app-root");
const passwordOverlay = document.getElementById("password-overlay");
const passwordForm = document.getElementById("password-form");
const passwordError = document.getElementById("password-error");
const passwordSubmit = document.getElementById("password-submit");
const passwordFields = ["current-password", "new-password", "new-password2"].map((id) => document.getElementById(id));
const MIN_PASSWORD_LENGTH = Number(appRoot.dataset.minPasswordLength);

function closePasswordDialog() {
  passwordOverlay.hidden = true;
  passwordFields.forEach((field) => { field.value = ""; });
}

document.getElementById("change-password-btn").addEventListener("click", () => {
  passwordError.textContent = "";
  passwordOverlay.hidden = false;
  passwordFields[0].focus();
});
document.getElementById("password-cancel").addEventListener("click", closePasswordDialog);
passwordOverlay.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !passwordSubmit.disabled) closePasswordDialog();
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  passwordError.textContent = "";
  const [current, next, confirm] = passwordFields.map((field) => field.value);
  if ([...next].length < MIN_PASSWORD_LENGTH) {
    passwordError.textContent = `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    return;
  }
  if (next !== confirm) {
    passwordError.textContent = "New passwords don't match.";
    return;
  }
  passwordSubmit.disabled = true;
  passwordSubmit.textContent = "Changing…";
  try {
    // Get every pending save in under the old password first - the server
    // ends this session's old key as part of the change.
    await flushPendingSave();
    await whenSaved();
    const res = await api("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      passwordError.textContent = data.error || "Something went wrong.";
      return;
    }
    scheduleLock(data.expires_in); // a fresh login under the new password
    closePasswordDialog();
    setStatus("Password changed. Other devices will need the new password.", 5000);
  } catch (err) {
    passwordError.textContent = "Couldn't reach the server - check your connection.";
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = "Change password";
  }
});
