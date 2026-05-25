import { HttpRangeReader, openFits, readImage } from "@fits-js/core";

const DEFAULT_URL = "https://fits.gsfc.nasa.gov/samples/NICMOSn4hk12010_mos.fits";
const url = process.argv[2] ?? DEFAULT_URL;

const reader = new HttpRangeReader(url);
const { hdus } = await openFits(reader);

console.log(`${url}: ${hdus.length} HDU${hdus.length === 1 ? "" : "s"}`);
for (const hdu of hdus) {
  const name = hdu.name ?? (hdu.type === "primary" ? "PRIMARY" : "");
  console.log(`  [${hdu.index}] ${hdu.type.padEnd(8)} ${name}`);
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
    console.log(
      `\nHDU [${image.index}] ${n1}x${n2}, ${cut.shape[0]}x${cut.shape[1]} cutout at (0,0):`,
    );
    console.log(`  ${values.join(", ")}`);
  }
}
