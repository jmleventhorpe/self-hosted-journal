// The journal page. Each module sets up its own part of the page when
// imported; this one connects the pieces that need each other and loads
// the first page.
//
//   state.js     shared state (which day/page, calendar view, ...)
//   session.js   requests to the server, and unlocking when a login ends
//   editor.js    the Quill editor, images, word count
//   saving.js    autosave, retries, conflicts
//   calendar.js  the month calendar
//   pages.js     switching between days and special pages
//   search.js    the search box
//   password.js  the change password dialog

import { onDayChosen, refreshEntryDates, renderCalendar } from "./calendar.js";
import { onEdit } from "./editor.js";
import { loadCurrent, switchToDate, updateHeader } from "./pages.js";
import { flushPendingSave, scheduleSave } from "./saving.js";
import "./search.js";
import "./password.js";

onEdit(scheduleSave);
onDayChosen(switchToDate);

document.getElementById("logout-btn").addEventListener("click", async () => {
  await flushPendingSave();
  await fetch("/logout", { method: "POST" });
  window.location.href = "/";
});

updateHeader();
await refreshEntryDates();
await loadCurrent();
renderCalendar();
