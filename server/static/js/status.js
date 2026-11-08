// The status bar under the editor.

const statusEl = document.getElementById("status");

export function setStatus(text, timeout, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-error", isError);
  if (timeout) {
    setTimeout(() => {
      if (statusEl.textContent === text) statusEl.textContent = "";
    }, timeout);
  }
}
