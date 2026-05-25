import { BlobReader, openFits, readImage } from "@fits-js/core";

const input = document.getElementById("file") as HTMLInputElement;
const out = document.getElementById("out") as HTMLPreElement;

async function handleChange(): Promise<void> {
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  out.textContent = `Reading ${file.name} (${file.size.toLocaleString()} bytes)...`;
  try {
    const reader = new BlobReader(file);
    const { hdus } = await openFits(reader);

    const lines = [`${file.name}: ${hdus.length} HDU${hdus.length === 1 ? "" : "s"}`];
    for (const hdu of hdus) {
      const name = hdu.name ?? (hdu.type === "primary" ? "PRIMARY" : "");
      lines.push(`  [${hdu.index}] ${hdu.type.padEnd(8)} ${name}`);
    }

    const image = hdus.find(
      (h) => (h.type === "primary" || h.type === "image") && h.header.getNumber("NAXIS") === 2,
    );
    if (image) {
      const n1 = image.header.getNumber("NAXIS1") ?? 0;
      const n2 = image.header.getNumber("NAXIS2") ?? 0;
      if (n1 > 0 && n2 > 0) {
        const region = { start: [0, 0], shape: [Math.min(8, n1), Math.min(2, n2)] };
        const cut = await readImage(image, reader, { region });
        const values = Array.from(cut.data as ArrayLike<number | bigint>);
        lines.push(
          ``,
          `HDU [${image.index}] ${n1}x${n2}, ${cut.shape[0]}x${cut.shape[1]} cutout at (0,0):`,
          `  ${values.join(", ")}`,
        );
      }
    }

    out.textContent = lines.join("\n");
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

input.addEventListener("change", () => {
  void handleChange();
});
