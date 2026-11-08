// Which page is on screen - a day or a special page - and switching
// between them: loading it into the editor, the heading above it, and the
// phone layout's Calendar / Entry tabs.

import { renderCalendar } from "./calendar.js";
import { formatDate, formatDateLabel } from "./dates.js";
import { quill, showInEditor, toDisplayHtml, updateWordCount } from "./editor.js";
import { flushPendingSave, unsaved, versions } from "./saving.js";
import { api, isUnlockOpen } from "./session.js";
import { SPECIAL_PAGES, currentPath, state } from "./state.js";
import { setStatus } from "./status.js";

const ENTRY_PLACEHOLDER = "Start writing…";

const appRoot = document.getElementById("app-root");
const dateLabel = document.getElementById("date-label");
const editorEl = document.getElementById("editor");
const prevDayBtn = document.getElementById("prev-day");
const nextDayBtn = document.getElementById("next-day");
const importTemplateBtn = document.getElementById("import-template-btn");
const mobileTabCalendar = document.getElementById("mobile-tab-calendar");
const mobileTabEditor = document.getElementById("mobile-tab-editor");
const specialPageButtons = {
  template: document.getElementById("template-btn"),
  info: document.getElementById("info-btn"),
};

// Only matters below the CSS breakpoint (see style.css) - on desktop both
// panels are always visible regardless of this class.
function showMobileView(view) {
  appRoot.classList.toggle("view-calendar", view === "calendar");
  appRoot.classList.toggle("view-editor", view === "editor");
  mobileTabCalendar.classList.toggle("active", view === "calendar");
  mobileTabEditor.classList.toggle("active", view === "editor");
}
mobileTabCalendar.addEventListener("click", () => showMobileView("calendar"));
mobileTabEditor.addEventListener("click", () => showMobileView("editor"));

export async function switchToDate(dateStr) {
  // Bring the date's month into view too - matters for Today and for
  // clicking a greyed-out day from the neighbouring month.
  const [y, m] = dateStr.split("-").map(Number);
  state.viewYear = y;
  state.viewMonth = m - 1;
  if (!state.currentSpecialPage && dateStr === state.selectedDate) {
    renderCalendar();
    showMobileView("editor");
    return;
  }
  await flushPendingSave();
  state.selectedDate = dateStr;
  state.currentSpecialPage = null;
  Object.values(specialPageButtons).forEach((button) => button.classList.remove("active"));
  updateHeader();
  await loadCurrent();
  renderCalendar();
  showMobileView("editor");
}

async function showSpecialPage(pageName) {
  await flushPendingSave();
  state.currentSpecialPage = state.currentSpecialPage === pageName ? null : pageName;
  Object.entries(specialPageButtons).forEach(([name, button]) =>
    button.classList.toggle("active", name === state.currentSpecialPage));
  updateHeader();
  await loadCurrent();
  renderCalendar();
  showMobileView("editor");
}

specialPageButtons.template.addEventListener("click", () => showSpecialPage("template"));
specialPageButtons.info.addEventListener("click", () => showSpecialPage("info"));

// Everything above the editor that depends on which page is showing.
export function updateHeader() {
  const special = state.currentSpecialPage && SPECIAL_PAGES[state.currentSpecialPage];
  dateLabel.textContent = special ? special.label : formatDateLabel(state.selectedDate);
  // Hidden but still taking up their space, so the bar keeps the same
  // height and the title stays put when switching to Template or Info.
  // (visibility: hidden also takes them out of the tab order.)
  for (const el of [importTemplateBtn, prevDayBtn, nextDayBtn]) {
    el.style.visibility = special ? "hidden" : "";
  }
  quill.root.setAttribute("data-placeholder", special ? special.placeholder : ENTRY_PLACEHOLDER);
}

export async function loadCurrent() {
  const path = currentPath();
  const seq = ++state.loadSeq;
  state.loading = true;
  // Locked while loading: anything typed now would be typed into the
  // previous page's text and then thrown away when this one arrives.
  quill.disable();
  editorEl.classList.add("is-loading");
  try {
    const res = await api(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // You've moved on to another page since this request went out - the
    // newer load owns the editor now.
    if (seq !== state.loadSeq) return;
    // A previous save of this page that hasn't gone through yet is newer
    // than what the server has - show that instead, and keep the version
    // it was based on so a conflicting change is still caught.
    if (unsaved.has(path)) {
      showInEditor(unsaved.get(path));
    } else {
      versions.set(path, data.version);
      showInEditor(data.html);
    }
    quill.enable();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    // Never leave the previous page's content editable under this page's
    // label - the next autosave would write it to the wrong date.
    quill.setText("", "silent");
    updateWordCount();
    setStatus("Couldn't load this page - check your connection and try again.", 0, true);
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      editorEl.classList.remove("is-loading");
    }
  }
}

// --- Previous / next day

function shiftDay(delta) {
  if (state.currentSpecialPage) return;
  const [y, m, d] = state.selectedDate.split("-").map(Number);
  switchToDate(formatDate(new Date(y, m - 1, d + delta)));
}

prevDayBtn.addEventListener("click", () => shiftDay(-1));
nextDayBtn.addEventListener("click", () => shiftDay(1));
// Alt+PageUp/PageDown work from anywhere, including while typing. (Not
// Alt+arrows - those are the browser's Back/Forward.)
document.addEventListener("keydown", (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== "PageUp" && event.key !== "PageDown") return;
  if (isUnlockOpen() || state.currentSpecialPage) return;
  event.preventDefault();
  shiftDay(event.key === "PageUp" ? -1 : 1);
});

importTemplateBtn.addEventListener("click", async () => {
  const res = await api("/template");
  const data = await res.json();
  if (!data.html) {
    setStatus("No template saved yet - click Template to create one.", 3000);
    return;
  }
  const range = quill.getSelection(true);
  quill.clipboard.dangerouslyPasteHTML(range.index, toDisplayHtml(data.html));
  setStatus("Template imported", 1500);
});
