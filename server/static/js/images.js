// Image helpers: shrinking before upload, and display sizing.

// --- Display sizing: newly inserted images are scaled to a sensible
// default automatically, and a toolbar dropdown (next to Insert Image)
// rescales every image already in the entry. Scaling is by area, so a
// tall photo and a wide screenshot picked at the same preset end up with
// a similar visual footprint.
//
// Sized via the plain width/height HTML *attributes*, not CSS - Quill
// keeps those on <img> through its Delta model, and existing entries
// already store sizes that way.
export const STANDARD_IMAGE_AREA = 400 * 400;
export const IMAGE_RESIZE_PRESETS = [
  ["Small", STANDARD_IMAGE_AREA / 4],
  ["Standard", STANDARD_IMAGE_AREA],
  ["Large", Math.round(STANDARD_IMAGE_AREA * 2.25)],
];

export function scaledSizeForArea(naturalW, naturalH, targetArea) {
  const naturalArea = naturalW * naturalH;
  if (!naturalArea) return { width: naturalW, height: naturalH };
  const scale = Math.sqrt(targetArea / naturalArea);
  return {
    width: Math.max(1, Math.round(naturalW * scale)),
    height: Math.max(1, Math.round(naturalH * scale)),
  };
}

// --- Shrinking images before they're stored. A phone photo is often
// 3-8 MB; stored as-is it's downloaded on every view and re-encrypted on
// every password change. Anything bigger than MAX_IMAGE_SIDE is scaled
// down, and photos are re-encoded as JPEG - which also drops their
// metadata (EXIF), including the GPS location phones attach.
const MAX_IMAGE_SIDE = 2000;
const JPEG_QUALITY = 0.85;

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function shrinkImage(file) {
  // Re-drawing a GIF would keep only its first frame.
  if (file.type === "image/gif") return readAsDataUrl(file);
  // createImageBitmap applies the photo's EXIF rotation, so portrait
  // shots stay upright once that metadata is gone.
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  // PNGs are usually screenshots: JPEG would blur their text, so they stay
  // PNG and are only touched if oversized.
  const isPng = file.type === "image/png";
  if (isPng && scale === 1) {
    bitmap.close();
    return readAsDataUrl(file);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!isPng) {
    // JPEG has no transparency - give see-through areas a white backing
    // rather than letting them turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", JPEG_QUALITY);
}
