// Sharepic ohne Bot bauen, z. B. zum Ausprobieren von Designs und Logos:
//   npm run sharepic -- "Barrieren abbauen!" --text "Erklärtext" --design lila-weiss-orange --logo laender/bayern --format 4:5 --bild foto.jpg --aus sharepic.png
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BOT_DIR } from "../src/config.mjs";
import { ladePpicng, logoNachId, farbschema } from "../src/ppicng.mjs";
import { schriftenAnmelden, sharepic } from "../src/grafik.mjs";
import { FORMATE } from "../src/video.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    text: { type: "string", default: "" },
    design: { type: "string", default: process.env.DESIGN || "weiss-schwarz-orange" },
    logo: { type: "string", default: process.env.LOGO || "common/piraten" },
    format: { type: "string", default: "1:1" },
    bild: { type: "string" },
    aus: { type: "string", default: "sharepic.png" },
  },
});
const ppicng = ladePpicng(path.resolve(BOT_DIR, process.env.PPICNG_DIR || "ppicng"));
schriftenAnmelden(ppicng);
const logo = values.logo === "kein" ? null : logoNachId(ppicng, values.logo);
if (values.logo !== "kein" && !logo) throw new Error(`Logo ${values.logo} gibt es nicht.`);
const masse = FORMATE[values.format];
if (!masse?.breite) throw new Error(`Format ${values.format}? Möglich: 1:1, 4:5, 9:16, 16:9`);
const png = await sharepic({ ...masse, schema: farbschema(values.design), claim: positionals.join(" ") || "Klarmachen zum Ändern!", text: values.text, logo, bild: values.bild });
fs.writeFileSync(values.aus, png);
console.log(`${values.aus}: ${masse.breite}×${masse.hoehe}, ${values.design}, ${logo?.titel ?? "ohne Logo"}`);
