// Getting edits to the server: autosave, retrying failed saves, conflicts
// with copies saved elsewhere, and a last-chance save when the tab closes.

import { refreshEntryDates } from "./calendar.js";
import { formatDateLabel } from "./dates.js";
import { editorStorageHtml, quill, showInEditor } from "./editor.js";
import { api } from "./session.js";
import { SPECIAL_PAGES, currentPath, state } from "./state.js";
import { setStatus } from "./status.js";

const AUTOSAVE_DELAY_MS = 1000;
const RETRY_DELAY_MS = 5000;

// path -> storage HTML not yet confirmed saved by the server. Kept across
// page switches so a failed save is retried (and shown again if you go
// back to that page) rather than silently dropped.
export const unsaved = new Map();
// path -> version token of the copy this page last loaded or saved (null
// if the page didn't exist). Sent with each save so the server can refuse
// it if the page has since been saved from another tab or device.
export const versions = new Map();
// path -> {html, version} of the other copy, for saves the server refused
// as conflicting. Those pages aren't retried until you choose what to keep.
const conflicts = new Map();
let saveChain = Promise.resolve(); // serializes saves so they can't land out of order
let autosaveTimer = null;
let retryTimer = null;

export function scheduleSave() {
  if (state.loading) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveCurrent();
  }, AUTOSAVE_DELAY_MS);
}

function saveCurrent() {
  unsaved.set(currentPath(), editorStorageHtml());
  return flushUnsaved();
}

// Saves the current page now if it has edits waiting for the autosave.
export async function flushPendingSave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    await saveCurrent();
  }
}

// Resolves once every save already started has finished (or failed).
export function whenSaved() {
  return saveChain;
}

// The server may store an image under a different id than the editor
// has: a newly inserted one arrives as an inline data: URI, and one from
// the template is copied to this page. Point the editor (and any newer
// save of this page still waiting to go) at the stored ids, so later
// saves send small references instead of re-uploading or re-copying.
const IMG_SRC_RE = /<img\b[^>]*?\bsrc="([^"]*)"/g;
const storageSrc = (src) => src.replace(/^\/images\/([a-f0-9]{32})$/, "$1");

function adoptStoredImageIds(path, sentHtml, storedSrcs) {
  if (!storedSrcs) return;
  const sentSrcs = [...sentHtml.matchAll(IMG_SRC_RE)].map((m) => m[1]);
  if (sentSrcs.length !== storedSrcs.length) return;
  const changed = sentSrcs
    .map((sent, i) => [sent, storedSrcs[i]])
    .filter(([sent, stored]) => sent !== stored);
  if (!changed.length) return;

  if (unsaved.has(path)) {
    let queued = unsaved.get(path);
    for (const [sent, stored] of changed) queued = queued.split(`src="${sent}"`).join(`src="${stored}"`);
    unsaved.set(path, queued);
  }

  // Only touch the editor if its images are exactly the ones just saved -
  // if you've added or removed one since, the next save sorts it out.
  if (path !== currentPath()) return;
  const imgs = [...quill.root.querySelectorAll("img")];
  const editorSrcs = imgs.map((img) => storageSrc(img.getAttribute("src") || ""));
  if (editorSrcs.length !== sentSrcs.length || editorSrcs.some((src, i) => src !== sentSrcs[i])) return;
  imgs.forEach((img, i) => {
    if (storedSrcs[i] !== sentSrcs[i]) img.setAttribute("src", `/images/${storedSrcs[i]}`);
  });
}

function saveBody(path, html) {
  const body = { html };
  if (versions.has(path)) body.base_version = versions.get(path);
  return JSON.stringify(body);
}

// Sends everything in `unsaved`. Never rejects - failures stay in
// `unsaved`, are reported in the status bar, and are retried.
function flushUnsaved() {
  saveChain = saveChain.then(async () => {
    if (!unsaved.size) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    setStatus("Saving…");
    for (const [path, html] of [...unsaved]) {
      if (conflicts.has(path)) continue; // waiting on your choice
      try {
        const res = await api(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: saveBody(path, html),
        });
        if (res.status === 409) {
          const theirs = await res.json();
          conflicts.set(path, { html: theirs.html, version: theirs.version });
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        versions.set(path, data.version);
        adoptStoredImageIds(path, html, data.image_srcs);
        // Only clear it if nothing newer for this page was queued meanwhile.
        if (unsaved.get(path) === html) unsaved.delete(path);
      } catch (err) {
        // Left in `unsaved` for the retry below.
      }
    }
    if (conflicts.size) showNextConflict();
    const failing = [...unsaved.keys()].some((path) => !conflicts.has(path));
    if (failing) {
      setStatus("Not saved - retrying…", 0, true);
      retryTimer = setTimeout(() => { retryTimer = null; flushUnsaved(); }, RETRY_DELAY_MS);
      return;
    }
    if (conflicts.size) {
      setStatus("Not saved - changed somewhere else.", 0, true);
      return;
    }
    setStatus("Saved", 1500);
    try { await refreshEntryDates(); } catch (err) { /* dots refresh on the next save */ }
  });
  return saveChain;
}

window.addEventListener("online", () => flushUnsaved());

// --- Conflicts: a save was refused because the page was saved from
// another tab or device after this one loaded it. Show both and let
// you choose; nothing is overwritten until you do.
const conflictOverlay = document.getElementById("conflict-overlay");
const conflictText = document.getElementById("conflict-text");
const conflictMine = document.getElementById("conflict-mine");
const conflictTheirs = document.getElementById("conflict-theirs");
let conflictPath = null; // the conflict currently on screen

function pageLabel(path) {
  const special = Object.values(SPECIAL_PAGES).find((p) => p.path === path);
  return special ? special.label : formatDateLabel(path.replace("/entries/", ""));
}

// Plain-text preview of stored HTML. DOMParser builds an inert document
// (no scripts run, no images load), and only its text is shown.
function htmlToPreviewText(html) {
  const body = new DOMParser().parseFromString(html || "", "text/html").body;
  const blocks = [...body.children].map((el) => el.textContent.trim()).filter(Boolean);
  return blocks.join("\n");
}

function showNextConflict() {
  if (conflictPath !== null || !conflicts.size) return;
  const [path, theirs] = conflicts.entries().next().value;
  conflictPath = path;
  conflictText.textContent = `${pageLabel(path)} was saved from another tab or device while you were editing it here. Choose what to keep - nothing is overwritten until you do.`;
  conflictMine.textContent = htmlToPreviewText(unsaved.get(path)) || "(empty)";
  conflictTheirs.textContent = theirs.html === null
    ? "(cleared - the entry was deleted)"
    : htmlToPreviewText(theirs.html) || "(no text - images only)";
  conflictOverlay.hidden = false;
  document.getElementById("conflict-keep-both").focus();
}

function resolveConflict(choice) {
  if (conflictPath === null) return;
  const path = conflictPath;
  const theirs = conflicts.get(path);
  const mine = unsaved.get(path) || "";
  const isCurrent = path === currentPath();
  if (isCurrent && autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  // Every choice builds on their copy now, so the next save is checked
  // against that.
  versions.set(path, theirs.version);
  if (choice === "theirs") {
    unsaved.delete(path);
    if (isCurrent) showInEditor(theirs.html);
  } else if (choice === "both") {
    const merged = (theirs.html || "") + mine;
    unsaved.set(path, merged);
    if (isCurrent) showInEditor(merged);
  }
  // "mine": unsaved already holds it - just resend on top of their version.
  conflicts.delete(path);
  conflictPath = null;
  conflictOverlay.hidden = true;
  if (conflicts.size) {
    showNextConflict();
  } else {
    flushUnsaved();
    if (choice === "theirs") {
      setStatus("Kept the other version", 2000);
      refreshEntryDates().catch(() => {});
    }
  }
}

document.getElementById("conflict-keep-both").addEventListener("click", () => resolveConflict("both"));
document.getElementById("conflict-keep-mine").addEventListener("click", () => resolveConflict("mine"));
document.getElementById("conflict-use-theirs").addEventListener("click", () => resolveConflict("theirs"));

// Coming back to a tab that's been in the background (e.g. the phone you
// wrote on yesterday): if this page was changed elsewhere meanwhile and
// you have no unsaved edits here, quietly show the newer copy - better
// than a conflict the moment you start typing.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  refreshEntryDates().catch(() => {});
  const path = currentPath();
  const seq = state.loadSeq;
  const untouched = () => !state.loading && !autosaveTimer && !unsaved.has(path)
    && !conflicts.has(path) && seq === state.loadSeq && path === currentPath();
  if (!untouched()) return;
  try {
    const res = await api(path);
    if (!res.ok) return;
    const data = await res.json();
    if (!untouched() || data.version === versions.get(path)) return;
    versions.set(path, data.version);
    showInEditor(data.html);
    setStatus("Updated with changes made elsewhere", 3000);
  } catch (err) {
    // Not worth reporting - the next save still checks for conflicts.
  }
});

window.addEventListener("beforeunload", (event) => {
  // Best-effort: a keepalive fetch outlives the page, unlike a normal one
  // which the browser cancels on unload. (Not sendBeacon - it can't send
  // an application/json body, which the server requires.) Browsers cap
  // keepalive bodies at 64KB; a bigger one throws and relies on the
  // prompt below.
  let warn = unsaved.size > 0; // saves were already failing
  if (autosaveTimer) unsaved.set(currentPath(), editorStorageHtml());
  unsaved.forEach((html, path) => {
    if (conflicts.has(path)) return; // would only be refused again
    try {
      fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: saveBody(path, html),
        keepalive: true,
      }).catch(() => {});
    } catch (err) {
      warn = true; // over the keepalive size limit - this one won't go
    }
  });
  // Ask before leaving rather than losing text without a word.
  if (warn) event.preventDefault();
});
