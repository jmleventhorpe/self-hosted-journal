// --- Search: typing in the box swaps the calendar for a results list;
// clearing it (or Escape) brings the calendar back. Results stay up while
// you click through them.

import { formatDateLabel } from "./dates.js";
import { switchToDate } from "./pages.js";
import { api } from "./session.js";
import { state } from "./state.js";

const SEARCH_DELAY_MS = 300;

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const calendarGrid = document.getElementById("calendar-grid");
let searchTimer = null;
let searchSeq = 0; // ignore responses to queries that have since changed

function showSearchResults(visible) {
  searchResults.hidden = !visible;
  calendarGrid.hidden = visible;
}

// Builds the snippet with <mark>s around each search term using text
// nodes only - entry text must never be interpreted as HTML here.
function highlightedSnippet(snippet, terms) {
  const frag = document.createDocumentFragment();
  const lowered = snippet.toLowerCase();
  let pos = 0;
  while (pos < snippet.length) {
    let best = -1;
    let bestLen = 0;
    for (const term of terms) {
      const i = lowered.indexOf(term, pos);
      if (i !== -1 && (best === -1 || i < best)) { best = i; bestLen = term.length; }
    }
    if (best === -1) break;
    frag.appendChild(document.createTextNode(snippet.slice(pos, best)));
    const mark = document.createElement("mark");
    mark.textContent = snippet.slice(best, best + bestLen);
    frag.appendChild(mark);
    pos = best + bestLen;
  }
  frag.appendChild(document.createTextNode(snippet.slice(pos)));
  return frag;
}

function renderSearchMessage(text) {
  searchResults.innerHTML = "";
  const p = document.createElement("p");
  p.className = "search-message";
  p.textContent = text;
  searchResults.appendChild(p);
}

async function runSearch(query) {
  const seq = ++searchSeq;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  try {
    const res = await api("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!data.results.length) {
      renderSearchMessage("No entries match.");
      return;
    }
    searchResults.innerHTML = "";
    const count = document.createElement("p");
    count.className = "search-message";
    const n = data.results.length;
    count.textContent = data.truncated ? `Showing the newest ${n} matches` : `${n} ${n === 1 ? "entry" : "entries"}`;
    searchResults.appendChild(count);
    data.results.forEach(({ date, snippet }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-result";
      item.classList.toggle("selected", !state.currentSpecialPage && date === state.selectedDate);
      item.dataset.date = date;
      const label = document.createElement("span");
      label.className = "search-result-date";
      label.textContent = formatDateLabel(date);
      const text = document.createElement("span");
      text.className = "search-result-snippet";
      text.appendChild(highlightedSnippet(snippet, terms));
      item.append(label, text);
      item.addEventListener("click", async () => {
        await switchToDate(date);
        searchResults.querySelectorAll(".search-result").forEach((el) =>
          el.classList.toggle("selected", el.dataset.date === date));
      });
      searchResults.appendChild(item);
    });
  } catch (err) {
    if (seq === searchSeq) renderSearchMessage("Search failed - check your connection.");
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query) {
    searchSeq++; // drop any in-flight response
    showSearchResults(false);
    return;
  }
  showSearchResults(true);
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
});

// Using the month nav means you want the calendar back.
function clearSearch() {
  if (!searchInput.value) return;
  searchInput.value = "";
  searchInput.dispatchEvent(new Event("input"));
}
const calendarNav = document.querySelector(".calendar-nav");
calendarNav.addEventListener("click", (event) => { if (event.target.closest("button")) clearSearch(); });
calendarNav.addEventListener("change", clearSearch);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchInput.value) {
    event.preventDefault();
    clearSearch();
  }
});
