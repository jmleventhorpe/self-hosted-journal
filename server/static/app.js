(() => {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // getDay(): 0=Sun, 1=Mon, ... 6=Sat. Tue/Thu/Sun get a highlighted
  // background as the actually-used days; Sunday is deliberately excluded
  // from the muted "weekend" treatment below since it's one of these.
  const USAGE_DAYS = new Set([0, 2, 4]);
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const AUTOSAVE_DELAY_MS = 1000;

  const quill = new Quill("#editor", {
    theme: "snow",
    modules: {
      toolbar: [
        ["bold", "italic"],
        [{ header: [1, 2, 3, false] }],
        [{ size: ["small", false, "large", "huge"] }],
        ["image"],
        ["clean"],
      ],
    },
  });

  // --- Image sizing: newly inserted images are scaled to a sensible
  // default automatically, and a toolbar dropdown (next to Insert Image)
  // rescales every image already in the entry. Scaling is by area, so a
  // tall photo and a wide screenshot picked at the same preset end up with
  // a similar visual footprint.
  //
  // Sized via the plain width/height HTML *attributes*, not CSS - Quill
  // keeps those on <img> through its Delta model, and existing entries
  // already store sizes that way.
  const STANDARD_IMAGE_AREA = 400 * 400;
  const IMAGE_RESIZE_PRESETS = [
    ["Small", STANDARD_IMAGE_AREA / 4],
    ["Standard", STANDARD_IMAGE_AREA],
    ["Large", Math.round(STANDARD_IMAGE_AREA * 2.25)],
  ];

  function scaledSizeForArea(naturalW, naturalH, targetArea) {
    const naturalArea = naturalW * naturalH;
    if (!naturalArea) return { width: naturalW, height: naturalH };
    const scale = Math.sqrt(targetArea / naturalArea);
    return {
      width: Math.max(1, Math.round(naturalW * scale)),
      height: Math.max(1, Math.round(naturalH * scale)),
    };
  }

  quill.getModule("toolbar").addHandler("image", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const probe = new Image();
        probe.onload = () => {
          const { width, height } = scaledSizeForArea(probe.naturalWidth, probe.naturalHeight, STANDARD_IMAGE_AREA);
          const range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
          quill.insertEmbed(range.index, "image", dataUrl, "user");
          quill.setSelection(range.index + 1, 0, "silent");
          const [leaf] = quill.getLeaf(range.index);
          if (leaf && leaf.domNode && leaf.domNode.tagName === "IMG") {
            leaf.domNode.setAttribute("width", width);
            leaf.domNode.setAttribute("height", height);
          }
        };
        probe.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });

  function resizeAllImages(targetArea) {
    const imgs = quill.root.querySelectorAll("img");
    if (!imgs.length) {
      setStatus("No images in this entry.", 2000);
      return;
    }
    imgs.forEach((imgEl) => {
      const nw = imgEl.naturalWidth;
      const nh = imgEl.naturalHeight;
      if (!nw || !nh) return;
      const { width, height } = scaledSizeForArea(nw, nh, targetArea);
      imgEl.setAttribute("width", width);
      imgEl.setAttribute("height", height);
    });
    // Direct DOM mutation, not a Quill API call, so it doesn't fire
    // Quill's text-change event - schedule the save ourselves.
    scheduleSave();
  }

  const resizeImagesSelect = document.createElement("select");
  resizeImagesSelect.className = "resize-images-select";
  resizeImagesSelect.title = "Resize all images in this entry";
  const resizePlaceholder = document.createElement("option");
  resizePlaceholder.textContent = "Resize Images";
  resizePlaceholder.disabled = true;
  resizePlaceholder.selected = true;
  resizePlaceholder.hidden = true;
  resizeImagesSelect.appendChild(resizePlaceholder);
  IMAGE_RESIZE_PRESETS.forEach(([label, area]) => {
    const opt = document.createElement("option");
    opt.value = area;
    opt.textContent = label;
    resizeImagesSelect.appendChild(opt);
  });
  resizeImagesSelect.addEventListener("change", () => {
    resizeAllImages(Number(resizeImagesSelect.value));
    resizeImagesSelect.selectedIndex = 0;
  });
  quill.getModule("toolbar").container
    .querySelector("button.ql-image")
    .insertAdjacentElement("afterend", resizeImagesSelect);

  const dateLabel = document.getElementById("date-label");
  const statusEl = document.getElementById("status");
  const editorEl = document.getElementById("editor");
  const wordCountEl = document.getElementById("word-count");
  const prevDayBtn = document.getElementById("prev-day");
  const nextDayBtn = document.getElementById("next-day");
  const calendarGrid = document.getElementById("calendar-grid");
  const monthSelect = document.getElementById("month-select");
  const yearSelect = document.getElementById("year-select");
  const templateBtn = document.getElementById("template-btn");
  const infoBtn = document.getElementById("info-btn");
  const importTemplateBtn = document.getElementById("import-template-btn");
  const appRoot = document.getElementById("app-root");
  const mobileTabCalendar = document.getElementById("mobile-tab-calendar");
  const mobileTabEditor = document.getElementById("mobile-tab-editor");

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

  MONTHS.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = name;
    monthSelect.appendChild(opt);
  });
  const thisYear = new Date().getFullYear();
  let earliestEntryYear = thisYear;

  // Spans from the earliest entry (or last year, if that's later) to next
  // year, stretched to include whatever year the prev/next arrows have
  // reached so the select never shows blank.
  function renderYearOptions() {
    const first = Math.min(earliestEntryYear, thisYear - 1, viewYear);
    const last = Math.max(thisYear + 1, viewYear);
    yearSelect.innerHTML = "";
    for (let y = last; y >= first; y--) {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    }
  }

  // "Special pages" are entries not tied to a date, edited in the same
  // editor as any day.
  const SPECIAL_PAGES = {
    template: {
      label: "Template", path: "/template", button: templateBtn,
      placeholder: "Write a template to import into entries…",
    },
    info: {
      label: "Info", path: "/info", button: infoBtn,
      placeholder: "Notes, lists, research - anything to keep handy…",
    },
  };

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-11
  let selectedDate = formatDate(today);
  let currentSpecialPage = null; // null, "template", or "info" - see SPECIAL_PAGES
  let entryDates = new Set();
  let focusDate = null; // calendar day that keyboard focus last sat on - see renderCalendar
  let loading = false; // guards against autosave firing while we're loading content
  let autosaveTimer = null;
  // path -> storage HTML not yet confirmed saved by the server. Kept across
  // page switches so a failed save is retried (and shown again if you go
  // back to that page) rather than silently dropped.
  const unsaved = new Map();
  let saveChain = Promise.resolve(); // serializes saves so they can't land out of order
  // path -> version token of the copy this page last loaded or saved (null
  // if the page didn't exist). Sent with each save so the server can refuse
  // it if the page has since been saved from another tab or device.
  const versions = new Map();
  // path -> {html, version} of the other copy, for saves the server refused
  // as conflicting. Those pages aren't retried until you choose what to keep.
  const conflicts = new Map();
  let loadSeq = 0; // only the newest load may touch the editor
  let retryTimer = null;
  const RETRY_DELAY_MS = 5000;

  function currentPath() {
    return currentSpecialPage ? SPECIAL_PAGES[currentSpecialPage].path : `/entries/${selectedDate}`;
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatDateLabel(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`;
  }

  // Rewrite stored `src="<resource-id>"` images to a fetchable URL before
  // handing HTML to Quill, and reverse it before saving. The server always
  // deals in bare resource ids (see server/app.py's _extract_inline_images) -
  // this rewriting is purely a browser-side concern.
  function toDisplayHtml(html) {
    return (html || "").replace(/src="([a-f0-9]{32})"/g, 'src="/images/$1"');
  }
  function toStorageHtml(html) {
    return html.replace(/src="\/images\/([a-f0-9]{32})"/g, 'src="$1"');
  }

  // A 401 means the server forgot this session (e.g. it restarted - keys
  // live only in its memory). Rather than navigating away and losing
  // whatever is in the editor, ask for the password in place, then retry
  // the request. Concurrent 401s share the one prompt.
  async function api(path, options) {
    for (;;) {
      const res = await fetch(path, options);
      if (res.status !== 401) return res;
      await promptUnlock();
    }
  }

  const unlockOverlay = document.getElementById("unlock-overlay");
  const unlockForm = document.getElementById("unlock-form");
  const unlockPassword = document.getElementById("unlock-password");
  const unlockError = document.getElementById("unlock-error");
  const unlockSubmit = unlockForm.querySelector("button[type=submit]");
  let unlockPromise = null;
  let resolveUnlock = null;

  function promptUnlock() {
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        unlockError.textContent = data.error || "Something went wrong.";
        return;
      }
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

  function setStatus(text, timeout, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("status-error", isError);
    if (timeout) {
      setTimeout(() => {
        if (statusEl.textContent === text) statusEl.textContent = "";
      }, timeout);
    }
  }

  async function refreshEntryDates() {
    const res = await api("/api/dates");
    const data = await res.json();
    entryDates = new Set(data.dates);
    if (data.dates.length) earliestEntryYear = Number(data.dates[0].slice(0, 4));
    renderCalendar();
  }

  function renderCalendar() {
    // Rebuilding the grid destroys the focused cell - remember whether
    // keyboard focus was in it so we can put it back on the new one.
    const hadFocus = calendarGrid.contains(document.activeElement);
    renderYearOptions();
    monthSelect.value = viewMonth;
    yearSelect.value = viewYear;
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
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startOffset = firstOfMonth.getDay(); // 0=Sun
    const gridStart = new Date(viewYear, viewMonth, 1 - startOffset);

    // Roving tabindex: exactly one day is in the tab order - the last one
    // focused if it's in this month, else the selected day, else the 1st.
    const inViewMonth = (dateStr) => dateStr && dateStr.startsWith(formatDate(firstOfMonth).slice(0, 8));
    const tabbableDate = inViewMonth(focusDate) ? focusDate
      : inViewMonth(selectedDate) ? selectedDate
      : formatDate(firstOfMonth);

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + i);
      const dateStr = formatDate(cellDate);
      const dow = cellDate.getDay();
      const hasEntry = entryDates.has(dateStr);
      const isSelected = !currentSpecialPage && dateStr === selectedDate;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "day";
      cell.dataset.date = dateStr;
      cell.tabIndex = dateStr === tabbableDate ? 0 : -1;
      if (cellDate.getMonth() !== viewMonth) cell.classList.add("other-month");
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
        focusDate = dateStr;
        switchToDate(dateStr);
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
    focusDate = formatDate(next);
    viewYear = next.getFullYear();
    viewMonth = next.getMonth();
    renderCalendar();
  });


  async function flushPendingSave() {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      await saveCurrent();
    }
  }

  async function switchToDate(dateStr) {
    // Bring the date's month into view too - matters for Today and for
    // clicking a greyed-out day from the neighbouring month.
    const [y, m] = dateStr.split("-").map(Number);
    viewYear = y;
    viewMonth = m - 1;
    if (!currentSpecialPage && dateStr === selectedDate) {
      renderCalendar();
      showMobileView("editor");
      return;
    }
    await flushPendingSave();
    selectedDate = dateStr;
    currentSpecialPage = null;
    Object.values(SPECIAL_PAGES).forEach((p) => p.button.classList.remove("active"));
    updateHeader();
    await loadCurrent();
    renderCalendar();
    showMobileView("editor");
  }

  const ENTRY_PLACEHOLDER = "Start writing…";

  // Everything above the editor that depends on which page is showing.
  function updateHeader() {
    const special = currentSpecialPage && SPECIAL_PAGES[currentSpecialPage];
    dateLabel.textContent = special ? special.label : formatDateLabel(selectedDate);
    importTemplateBtn.style.display = special ? "none" : "";
    prevDayBtn.hidden = !!special;
    nextDayBtn.hidden = !!special;
    quill.root.setAttribute("data-placeholder", special ? special.placeholder : ENTRY_PLACEHOLDER);
  }

  function shiftDay(delta) {
    if (currentSpecialPage) return;
    const [y, m, d] = selectedDate.split("-").map(Number);
    switchToDate(formatDate(new Date(y, m - 1, d + delta)));
  }

  async function showSpecialPage(pageName) {
    await flushPendingSave();
    currentSpecialPage = currentSpecialPage === pageName ? null : pageName;
    Object.entries(SPECIAL_PAGES).forEach(([name, p]) => p.button.classList.toggle("active", name === currentSpecialPage));
    updateHeader();
    await loadCurrent();
    renderCalendar();
    showMobileView("editor");
  }

  // Puts HTML in the editor without it counting as an edit.
  function showInEditor(html) {
    loading = true;
    // Not quill.root.innerHTML = ... - that bypasses Quill's own Delta
    // model, leaving it out of sync with the DOM. Quill's internal
    // MutationObserver then "reconciles" the external change, which is
    // what was intermittently inserting extra empty paragraphs. This
    // (single-string-argument) form of dangerouslyPasteHTML replaces the
    // whole document through Quill's normal setContents path instead.
    quill.clipboard.dangerouslyPasteHTML(toDisplayHtml(html), "silent");
    loading = false;
    updateWordCount(); // "silent" above means text-change didn't fire
  }

  async function loadCurrent() {
    const path = currentPath();
    const seq = ++loadSeq;
    loading = true;
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
      if (seq !== loadSeq) return;
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
      if (seq !== loadSeq) return;
      // Never leave the previous page's content editable under this page's
      // label - the next autosave would write it to the wrong date.
      quill.setText("", "silent");
      updateWordCount();
      setStatus("Couldn't load this page - check your connection and try again.", 0, true);
    } finally {
      if (seq === loadSeq) {
        loading = false;
        editorEl.classList.remove("is-loading");
      }
    }
  }


  // Quill's "empty" document is still <p><br></p>, which would otherwise be
  // saved as a real (blank) entry and leave a dot on the calendar.
  function editorStorageHtml() {
    const isEmpty = !quill.getText().trim() && !quill.root.querySelector("img");
    return isEmpty ? "" : toStorageHtml(quill.root.innerHTML);
  }

  function scheduleSave() {
    if (loading) return;
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

  // Sends everything in `unsaved`. Never rejects - failures stay in
  // `unsaved`, are reported in the status bar, and are retried.
  function saveBody(path, html) {
    const body = { html };
    if (versions.has(path)) body.base_version = versions.get(path);
    return JSON.stringify(body);
  }

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
    const seq = loadSeq;
    const untouched = () => !loading && !autosaveTimer && !unsaved.has(path)
      && !conflicts.has(path) && seq === loadSeq && path === currentPath();
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


  window.addEventListener("online", () => flushUnsaved());

  function updateWordCount() {
    const words = quill.getText().split(/\s+/).filter(Boolean).length;
    wordCountEl.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "";
  }

  quill.on("text-change", () => {
    updateWordCount();
    scheduleSave();
  });

  document.getElementById("prev-month").addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
  });
  prevDayBtn.addEventListener("click", () => shiftDay(-1));
  nextDayBtn.addEventListener("click", () => shiftDay(1));
  // Alt+PageUp/PageDown work from anywhere, including while typing. (Not
  // Alt+arrows - those are the browser's Back/Forward.)
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "PageUp" && event.key !== "PageDown") return;
    if (!unlockOverlay.hidden || currentSpecialPage) return;
    event.preventDefault();
    shiftDay(event.key === "PageUp" ? -1 : 1);
  });
  // --- Search: typing in the box swaps the calendar for a results list;
  // clearing it (or Escape) brings the calendar back. Results stay up
  // while you click through them.
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const SEARCH_DELAY_MS = 300;
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
        item.classList.toggle("selected", !currentSpecialPage && date === selectedDate);
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

  document.getElementById("today-btn").addEventListener("click", () => switchToDate(formatDate(new Date())));
  document.getElementById("next-month").addEventListener("click", () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendar();
  });
  monthSelect.addEventListener("change", () => {
    viewMonth = Number(monthSelect.value);
    renderCalendar();
  });
  yearSelect.addEventListener("change", () => {
    viewYear = Number(yearSelect.value);
    renderCalendar();
  });

  templateBtn.addEventListener("click", () => showSpecialPage("template"));
  infoBtn.addEventListener("click", () => showSpecialPage("info"));

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

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await flushPendingSave();
    await fetch("/logout", { method: "POST" });
    window.location.href = "/";
  });

  window.addEventListener("beforeunload", (event) => {
    // Best-effort: fires synchronously enough for a same-origin POST via
    // sendBeacon, unlike a normal fetch which the browser may cancel.
    const alreadyFailing = unsaved.size > 0;
    if (autosaveTimer) unsaved.set(currentPath(), editorStorageHtml());
    unsaved.forEach((html, path) => {
      if (conflicts.has(path)) return; // would only be refused again
      const blob = new Blob([saveBody(path, html)], { type: "application/json" });
      navigator.sendBeacon(path, blob);
    });
    // Saves were already failing, so the beacon probably will too - ask
    // before leaving rather than losing the text without a word.
    if (alreadyFailing) event.preventDefault();
  });

  (async function init() {
    updateHeader();
    await refreshEntryDates();
    await loadCurrent();
    renderCalendar();
  })();
})();
