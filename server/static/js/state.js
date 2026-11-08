// State shared between modules. It lives in one object so any module can
// update it - a `let` exported from a module can't be assigned elsewhere.

import { formatDate } from "./dates.js";

// "Special pages" are entries not tied to a date, edited in the same
// editor as any day.
export const SPECIAL_PAGES = {
  template: {
    label: "Template", path: "/template",
    placeholder: "Write a template to import into entries…",
  },
  info: {
    label: "Info", path: "/info",
    placeholder: "Notes, lists, research - anything to keep handy…",
  },
};

const today = new Date();

export const state = {
  viewYear: today.getFullYear(),
  viewMonth: today.getMonth(), // 0-11
  selectedDate: formatDate(today),
  currentSpecialPage: null, // null, "template", or "info" - see SPECIAL_PAGES
  entryDates: new Set(),
  earliestEntryYear: today.getFullYear(),
  focusDate: null, // calendar day that keyboard focus last sat on - see renderCalendar
  loading: false, // guards against autosave firing while we're loading content
  loadSeq: 0, // only the newest load may touch the editor
};

export function currentPath() {
  return state.currentSpecialPage
    ? SPECIAL_PAGES[state.currentSpecialPage].path
    : `/entries/${state.selectedDate}`;
}
