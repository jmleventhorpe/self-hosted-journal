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
  // rescales every image already in the entry. Mirrors the desktop app's
  // Small/Standard/Large presets and area-based scaling (see editor.py's
  // _scaled_size_for_area) so a tall photo and a wide screenshot picked at
  // the same preset end up with a similar visual footprint.
  //
  // Sized via the plain width/height HTML *attributes*, not CSS - that's
  // what the desktop app's QTextImageFormat produces, and Qt's HTML
  // renderer reliably reads that form but isn't guaranteed to honor
  // arbitrary inline CSS. Using the same mechanism keeps images resized by
  // either client fully interoperable with the other.
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
  // editor as any day - mirrors the desktop app's SPECIAL_PAGES.
  const SPECIAL_PAGES = {
    template: { label: "Template", path: "/template", button: templateBtn },
    info: { label: "Info", path: "/info", button: infoBtn },
  };

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-11
  let selectedDate = formatDate(today);
  let currentSpecialPage = null; // null, "template", or "info" - see SPECIAL_PAGES
  let entryDates = new Set();
  let loading = false; // guards against autosave firing while we're loading content
  let autosaveTimer = null;
  // path -> storage HTML not yet confirmed saved by the server. Kept across
  // page switches so a failed save is retried (and shown again if you go
  // back to that page) rather than silently dropped.
  const unsaved = new Map();
  let saveChain = Promise.resolve(); // serializes saves so they can't land out of order
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
  // deals in bare resource ids (see server/app.py's _normalize_inline_images) -
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
    renderYearOptions();
    monthSelect.value = viewMonth;
    yearSelect.value = viewYear;
    calendarGrid.innerHTML = "";

    WEEKDAYS.forEach((name, i) => {
      const el = document.createElement("div");
      el.className = "weekday" + (i === 0 || i === 6 ? " weekend" : "");
      el.textContent = name;
      calendarGrid.appendChild(el);
    });

    // Recomputed each render rather than fixed at page load, so a tab left
    // open past midnight moves the highlight along.
    const todayStr = formatDate(new Date());
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startOffset = firstOfMonth.getDay(); // 0=Sun
    const gridStart = new Date(viewYear, viewMonth, 1 - startOffset);

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + i);
      const dateStr = formatDate(cellDate);
      const dow = cellDate.getDay();

      const cell = document.createElement("div");
      cell.className = "day";
      if (cellDate.getMonth() !== viewMonth) cell.classList.add("other-month");
      if (dow === 6) cell.classList.add("weekend");
      if (USAGE_DAYS.has(dow)) cell.classList.add("usage-day");
      if (dateStr === todayStr) cell.classList.add("today");
      if (!currentSpecialPage && dateStr === selectedDate) cell.classList.add("selected");
      cell.textContent = cellDate.getDate();

      if (entryDates.has(dateStr)) {
        const dot = document.createElement("span");
        dot.className = "dot";
        cell.appendChild(dot);
      }

      cell.addEventListener("click", () => switchToDate(dateStr));
      calendarGrid.appendChild(cell);
    }
  }

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
    importTemplateBtn.style.display = "";
    dateLabel.textContent = formatDateLabel(dateStr);
    await loadCurrent();
    renderCalendar();
    showMobileView("editor");
  }

  async function showSpecialPage(pageName) {
    await flushPendingSave();
    currentSpecialPage = currentSpecialPage === pageName ? null : pageName;
    Object.entries(SPECIAL_PAGES).forEach(([name, p]) => p.button.classList.toggle("active", name === currentSpecialPage));
    importTemplateBtn.style.display = currentSpecialPage ? "none" : "";
    dateLabel.textContent = currentSpecialPage ? SPECIAL_PAGES[currentSpecialPage].label : formatDateLabel(selectedDate);
    await loadCurrent();
    renderCalendar();
    showMobileView("editor");
  }

  async function loadCurrent() {
    const path = currentPath();
    loading = true;
    try {
      const res = await api(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // A previous save of this page that hasn't gone through yet is newer
      // than what the server has - show that instead.
      const html = unsaved.has(path) ? unsaved.get(path) : data.html;
      // Not quill.root.innerHTML = ... - that bypasses Quill's own Delta
      // model, leaving it out of sync with the DOM. Quill's internal
      // MutationObserver then "reconciles" the external change, which is
      // what was intermittently inserting extra empty paragraphs. This
      // (single-string-argument) form of dangerouslyPasteHTML replaces the
      // whole document through Quill's normal setContents path instead.
      quill.clipboard.dangerouslyPasteHTML(toDisplayHtml(html), "silent");
      quill.enable();
    } catch (err) {
      // Never leave the previous page's content editable under this page's
      // label - the next autosave would write it to the wrong date.
      quill.setText("", "silent");
      quill.disable();
      setStatus("Couldn't load this page - check your connection and try again.", 0, true);
    } finally {
      loading = false;
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
  function flushUnsaved() {
    saveChain = saveChain.then(async () => {
      if (!unsaved.size) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      setStatus("Saving…");
      for (const [path, html] of [...unsaved]) {
        try {
          const res = await api(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html, images: {} }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Only clear it if nothing newer for this page was queued meanwhile.
          if (unsaved.get(path) === html) unsaved.delete(path);
        } catch (err) {
          // Left in `unsaved` for the retry below.
        }
      }
      if (unsaved.size) {
        setStatus("Not saved - retrying…", 0, true);
        retryTimer = setTimeout(() => { retryTimer = null; flushUnsaved(); }, RETRY_DELAY_MS);
        return;
      }
      setStatus("Saved", 1500);
      try { await refreshEntryDates(); } catch (err) { /* dots refresh on the next save */ }
    });
    return saveChain;
  }

  window.addEventListener("online", () => flushUnsaved());

  quill.on("text-change", scheduleSave);

  document.getElementById("prev-month").addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
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
    if (!data.html && !Object.keys(data.images).length) {
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
      const blob = new Blob([JSON.stringify({ html, images: {} })], { type: "application/json" });
      navigator.sendBeacon(path, blob);
    });
    // Saves were already failing, so the beacon probably will too - ask
    // before leaving rather than losing the text without a word.
    if (alreadyFailing) event.preventDefault();
  });

  (async function init() {
    dateLabel.textContent = formatDateLabel(selectedDate);
    await refreshEntryDates();
    await loadCurrent();
    renderCalendar();
  })();
})();
