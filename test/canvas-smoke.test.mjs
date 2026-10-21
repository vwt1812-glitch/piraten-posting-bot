import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadImage } from "@napi-rs/canvas";
import { ladePpicng, logoNachId, farbschema } from "../src/ppicng.mjs";
import { schriftenAnmelden, sharepic } from "../src/grafik.mjs";

test("native canvas renders ppicng fonts and logo and decodes the PNG", async () => {
  console.log(`Canvas platform: ${process.platform}/${process.arch}`);
  const data = ladePpicng(fileURLToPath(new URL("../ppicng", import.meta.url)));
  schriftenAnmelden(data);
  const png = await sharepic({
    breite: 1080, hoehe: 1350, schema: farbschema("lila-weiss-orange"),
    claim: "Freies WLAN", text: "für alle Schulen", logo: logoNachId(data, "common/piraten"),
  });
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const decoded = await loadImage(png);
  assert.equal(decoded.width, 1080);
  assert.equal(decoded.height, 1350);
  assert.ok(png.length > 10000);
});
