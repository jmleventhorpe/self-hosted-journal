// The month calendar: drawing it, moving around it with the mouse and
// keyboard, and the dots marking days with entries. Picking a day is
// reported through onDayChosen (wired to switching pages in main.js).

import { MONTHS, formatDate, formatDateLabel } from "./dates.js";
import { api } from "./session.js";
import { state } from "./state.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// getDay(): 0=Sun, 1=Mon, ... 6=Sat. Tue/Thu/Sun get a highlighted
// background as the actually-used days; Sunday is deliberately excluded
// from the muted "weekend" treatment below since it's one of these.
const USAGE_DAYS = new Set([0, 2, 4]);

const calendarGrid = document.getElementById("calendar-grid");
const monthSelect = document.getElementById("month-select");
const yearSelect = document.getElementById("year-select");
const thisYear = new Date().getFullYear();

let dayListener = () => {};

// Called with "YYYY-MM-DD" when a day is clicked, or Today is pressed.
export function onDayChosen(listener) {
  dayListener = listener;
}

MONTHS.forEach((name, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = name;
  monthSelect.appendChild(opt);
});

// Spans from the earliest entry (or last year, if that's later) to next
// year, stretched to include whatever year the prev/next arrows have
// reached so the select never shows blank.
function renderYearOptions() {
  const first = Math.min(state.earliestEntryYear, thisYear - 1, state.viewYear);
  const last = Math.max(thisYear + 1, state.viewYear);
  yearSelect.innerHTML = "";
  for (let y = last; y >= first; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearSelect.appendChild(opt);
  }
}

export async function refreshEntryDates() {
  const res = await api("/api/dates");
  const data = await res.json();
  state.entryDates = new Set(data.dates);
  if (data.dates.length) state.earliestEntryYear = Number(data.dates[0].slice(0, 4));
  renderCalendar();
}

export function renderCalendar() {
  // Rebuilding the grid destroys the focused cell - remember whether
  // keyboard focus was in it so we can put it back on the new one.
  const hadFocus = calendarGrid.contains(document.activeElement);
  renderYearOptions();
  monthSelect.value = state.viewMonth;
  yearSelect.value = state.viewYear;
  calendarGrid.innerHTML = "";

  WEEKDAYS.forEach((name, i) => {
    const el = document.createElement("div");
    el.className = "weekday" + (i === 0 || i === 6 ? " weekend" : "");
    el.textContent = name;
    el.setAttribute("aria-hidden", "true"); // each day's label already says its weekday
    calendarGrid.appendChild(el);
  });

  // Recomputed each render rather than fixed at page load, so a tab left
  // open past midnight moves the highlight along.
  const todayStr = formatDate(new Date());
  const firstOfMonth = new Date(state.viewYear, state.viewMonth, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(state.viewYear, state.viewMonth, 1 - startOffset);

  // Roving tabindex: exactly one day is in the tab order - the last one
  // focused if it's in this month, else the selected day, else the 1st.
  const inViewMonth = (dateStr) => dateStr && dateStr.startsWith(formatDate(firstOfMonth).slice(0, 8));
  const tabbableDate = inViewMonth(state.focusDate) ? state.focusDate
    : inViewMonth(state.selectedDate) ? state.selectedDate
    : formatDate(firstOfMonth);

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const dateStr = formatDate(cellDate);
    const dow = cellDate.getDay();
    const hasEntry = state.entryDates.has(dateStr);
    const isSelected = !state.currentSpecialPage && dateStr === state.selectedDate;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "day";
    cell.dataset.date = dateStr;
    cell.tabIndex = dateStr === tabbableDate ? 0 : -1;
    if (cellDate.getMonth() !== state.viewMonth) cell.classList.add("other-month");
    if (dow === 6) cell.classList.add("weekend");
    if (USAGE_DAYS.has(dow)) cell.classList.add("usage-day");
    if (dateStr === todayStr) {
      cell.classList.add("today");
      cell.setAttribute("aria-current", "date");
    }
    if (isSelected) cell.classList.add("selected");
    cell.textContent = cellDate.getDate();
    cell.setAttribute("aria-label", [
      formatDateLabel(dateStr),
      dateStr === todayStr && "today",
      hasEntry && "has entry",
      isSelected && "selected",
    ].filter(Boolean).join(", "));

    if (hasEntry) {
      const dot = document.createElement("span");
      dot.className = "dot";
      cell.appendChild(dot);
    }

    cell.addEventListener("click", () => {
      state.focusDate = dateStr;
      dayListener(dateStr);
    });
    calendarGrid.appendChild(cell);
  }

  if (hadFocus) {
    const target = calendarGrid.querySelector(`.day[tabindex="0"]`);
    if (target) target.focus();
  }
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// Standard date-picker keys: arrows move by day/week, Home/End to the
// start/end of the week, PageUp/PageDown by month. Moving past the edge
// of the month brings the new month into view. Enter/Space select (the
// cells are buttons, so that comes for free).
calendarGrid.addEventListener("keydown", (event) => {
  const cell = event.target.closest(".day");
  if (!cell) return;
  const [y, m, d] = cell.dataset.date.split("-").map(Number);
  let next;
  switch (event.key) {
    case "ArrowLeft": next = new Date(y, m - 1, d - 1); break;
    case "ArrowRight": next = new Date(y, m - 1, d + 1); break;
    case "ArrowUp": next = new Date(y, m - 1, d - 7); break;
    case "ArrowDown": next = new Date(y, m - 1, d + 7); break;
    case "Home": next = new Date(y, m - 1, d - new Date(y, m - 1, d).getDay()); break;
    case "End": next = new Date(y, m - 1, d + 6 - new Date(y, m - 1, d).getDay()); break;
    case "PageUp":
    case "PageDown": {
      const delta = event.key === "PageUp" ? -1 : 1;
      const first = new Date(y, m - 1 + delta, 1);
      next = new Date(first.getFullYear(), first.getMonth(),
        Math.min(d, daysInMonth(first.getFullYear(), first.getMonth())));
      break;
    }
    default: return;
  }
  event.preventDefault();
  state.focusDate = formatDate(next);
  state.viewYear = next.getFullYear();
  state.viewMonth = next.getMonth();
  renderCalendar();
});

// --- Month navigation

document.getElementById("prev-month").addEventListener("click", () => {
  state.viewMonth -= 1;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear -= 1; }
  renderCalendar();
});
document.getElementById("next-month").addEventListener("click", () => {
  state.viewMonth += 1;
  if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear += 1; }
  renderCalendar();
});
monthSelect.addEventListener("change", () => {
  state.viewMonth = Number(monthSelect.value);
  renderCalendar();
});
yearSelect.addEventListener("change", () => {
  state.viewYear = Number(yearSelect.value);
  renderCalendar();
});
document.getElementById("today-btn").addEventListener("click", () => dayListener(formatDate(new Date())));
