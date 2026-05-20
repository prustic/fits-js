import { fileURLToPath } from "node:url";
import { NodeFileReader, openFits, readImage } from "@fits-js/core";

const DEFAULT_FIXTURE = fileURLToPath(new URL("../fixtures/sample.fits", import.meta.url));

const path = process.argv[2] ?? DEFAULT_FIXTURE;
const reader = await NodeFileReader.open(path);

try {
  const { hdus } = await openFits(reader);

  console.log(`${path}: ${hdus.length} HDU${hdus.length === 1 ? "" : "s"}`);
  for (const hdu of hdus) {
    const name = hdu.header.getString("EXTNAME") ?? (hdu.type === "primary" ? "PRIMARY" : "");
    console.log(`  [${hdu.index}] ${hdu.type.padEnd(7)} ${name}`);
  }

  const primary = hdus[0];
  if (primary.type === "primary" && primary.header.getNumber("NAXIS") === 2) {
    const n1 = primary.header.getNumber("NAXIS1") ?? 0;
    const n2 = primary.header.getNumber("NAXIS2") ?? 0;
    const region = { start: [0, 0], shape: [Math.min(8, n1), Math.min(2, n2)] };

    const cut = await readImage(primary, reader, { region });
    console.log(`\nprimary ${n1}x${n2}, ${cut.shape[0]}x${cut.shape[1]} cutout at (0,0):`);
    console.log(`  ${(cut.data as Float32Array | Float64Array).join(", ")}`);
  }
} finally {
  await reader.close();
}
