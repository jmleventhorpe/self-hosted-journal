// The Quill editor: setup, images, the word count, and moving HTML in and
// out of it. Edits are reported through onEdit (wired to autosave in
// main.js) rather than by calling the saving code directly.

import { IMAGE_RESIZE_PRESETS, STANDARD_IMAGE_AREA, scaledSizeForArea, shrinkImage } from "./images.js";
import { state } from "./state.js";
import { setStatus } from "./status.js";

const wordCountEl = document.getElementById("word-count");

export const quill = new Quill("#editor", {
  theme: "snow",
  // Keeps the link bubble inside the editor instead of letting it slide
  // under the calendar panel next to it.
  bounds: "#editor",
  modules: {
    toolbar: [
      ["bold", "italic"],
      [{ header: [1, 2, 3, false] }],
      [{ size: ["small", false, "large", "huge"] }],
      [{ list: "bullet" }, { list: "ordered" }],
      ["link", "image"],
      ["clean"],
    ],
    // Images dragged or pasted in as files go through the same shrinking
    // and default sizing as the toolbar button (Quill's own handler would
    // embed them at full size).
    uploader: {
      handler(range, files) {
        files.filter((file) => file.type.startsWith("image/")).forEach((file) => insertImageFile(file, range.index));
      },
    },
  },
});

let editListener = () => {};

// Called on every edit the user makes.
export function onEdit(listener) {
  editListener = listener;
}

quill.on("text-change", () => {
  updateWordCount();
  editListener();
});

// --- Images

async function insertImageFile(file, index) {
  let dataUrl;
  try {
    dataUrl = await shrinkImage(file);
  } catch (err) {
    setStatus("Couldn't read that image - this browser may not support its format.", 4000, true);
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    const { width, height } = scaledSizeForArea(probe.naturalWidth, probe.naturalHeight, STANDARD_IMAGE_AREA);
    const at = index ?? (quill.getSelection(true) || { index: quill.getLength() }).index;
    quill.insertEmbed(at, "image", dataUrl, "user");
    quill.setSelection(at + 1, 0, "silent");
    // The just-inserted image is the one with this src and no size yet.
    const img = [...quill.root.querySelectorAll("img")]
      .find((el) => el.getAttribute("src") === dataUrl && !el.hasAttribute("width"));
    if (img) {
      img.setAttribute("width", width);
      img.setAttribute("height", height);
    }
  };
  probe.src = dataUrl;
}

quill.getModule("toolbar").addHandler("image", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", () => {
    if (input.files[0]) insertImageFile(input.files[0]);
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
  // Quill's text-change event - report the edit ourselves.
  editListener();
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

// --- HTML in and out

// Rewrite stored `src="<resource-id>"` images to a fetchable URL before
// handing HTML to Quill, and reverse it before saving. The server always
// deals in bare resource ids (see server/app.py's _extract_inline_images) -
// this rewriting is purely a browser-side concern.
export function toDisplayHtml(html) {
  return (html || "").replace(/src="([a-f0-9]{32})"/g, 'src="/images/$1"');
}
function toStorageHtml(html) {
  return html.replace(/src="\/images\/([a-f0-9]{32})"/g, 'src="$1"');
}

// Puts HTML in the editor without it counting as an edit.
export function showInEditor(html) {
  state.loading = true;
  // Not quill.root.innerHTML = ... - that bypasses Quill's own Delta
  // model, leaving it out of sync with the DOM. Quill's internal
  // MutationObserver then "reconciles" the external change, which is
  // what was intermittently inserting extra empty paragraphs. This
  // (single-string-argument) form of dangerouslyPasteHTML replaces the
  // whole document through Quill's normal setContents path instead.
  quill.clipboard.dangerouslyPasteHTML(toDisplayHtml(html), "silent");
  state.loading = false;
  updateWordCount(); // "silent" above means text-change didn't fire
}

// Quill's "empty" document is still <p><br></p>, which would otherwise be
// saved as a real (blank) entry and leave a dot on the calendar.
export function editorStorageHtml() {
  const isEmpty = !quill.getText().trim() && !quill.root.querySelector("img");
  return isEmpty ? "" : toStorageHtml(quill.root.innerHTML);
}

export function updateWordCount() {
  const words = quill.getText().split(/\s+/).filter(Boolean).length;
  wordCountEl.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "";
}
