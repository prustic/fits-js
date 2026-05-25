import { BlobReader, openFits, readImage, type Hdu, type ImageArray } from "@fits-js/core";

const input = document.getElementById("file") as HTMLInputElement;
const status = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

async function render(file: File): Promise<void> {
  status.textContent = `Reading ${file.name} (${file.size.toLocaleString()} bytes)...`;
  const reader = new BlobReader(file);
  const { hdus } = await openFits(reader);

  const image = hdus.find(
    (h) => (h.type === "primary" || h.type === "image") && h.header.getNumber("NAXIS") === 2,
  );
  if (!image) {
    status.textContent = `${file.name}: no 2D image HDU found`;
    return;
  }

  const w = image.header.getNumber("NAXIS1") ?? 0;
  const h = image.header.getNumber("NAXIS2") ?? 0;
  if (w === 0 || h === 0) {
    status.textContent = `${file.name}: HDU [${image.index}] has zero-length axes`;
    return;
  }

  const { data } = await readImage(image, reader);
  const [lo, hi] = robustRange(data);

  draw(data, w, h, lo, hi);
  status.textContent =
    `${file.name}: HDU [${image.index}] ${labelFor(image)} ${w}x${h}\n` +
    `display range [${lo.toPrecision(4)}, ${hi.toPrecision(4)}] (0.5%-99.5% percentile)`;
}

function labelFor(hdu: Hdu): string {
  return hdu.name ?? (hdu.type === "primary" ? "PRIMARY" : hdu.type.toUpperCase());
}

function robustRange(data: ImageArray): [number, number] {
  const buf = new Float64Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    if (Number.isFinite(v)) {
      buf[n++] = v;
    }
  }
  if (n === 0) {
    return [0, 1];
  }

  const finite = buf.subarray(0, n).sort();
  const lo = finite[Math.floor(n * 0.005)];
  const hi = finite[Math.floor(n * 0.995)];

  return lo === hi ? [lo, lo + 1] : [lo, hi];
}

function draw(data: ImageArray, w: number, h: number, lo: number, hi: number): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  const img = ctx.createImageData(w, h);
  const scale = 255 / (hi - lo);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const v = Number(data[srcY * w + x]);
      const norm = Number.isFinite(v) ? Math.max(0, Math.min(255, (v - lo) * scale)) : 0;
      const i = (y * w + x) * 4;
      img.data[i] = norm;
      img.data[i + 1] = norm;
      img.data[i + 2] = norm;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  input.disabled = true;
  render(file)
    .catch((err: unknown) => {
      status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    })
    .finally(() => {
      input.disabled = false;
    });
});
