// Anbindung an ppicng (https://github.com/Piratenpartei/ppicng), den Sharepic-Generator der Piratenpartei.
// Der Bot nimmt von dort, was das einheitliche Design ausmacht – so sehen Videos und Bilder aus dem Bot
// genauso aus wie die Sharepics aus der Web-App:
//   • Logos samt hellen/dunklen Varianten aus src/logos/logos.json (alle Gliederungen, AGs, JuPis …)
//   • Schriften Politics Head (Claim) und DejaRip (Fließtext) aus src/designs/*/fonts
//   • Farbschemata des Designs „classic“ (src/designs/classic/Image.tsx)
// ppicng liegt als Git-Submodul im Ordner ppicng/ (oder PPICNG_DIR). Neue Logos: git submodule update --remote.

import fs from "node:fs";
import path from "node:path";

/**
 * Farbschemata wie in ppicng „classic“: Hintergrund, Schrift, Linie unter dem Claim.
 * Die Namen sind „Hintergrund-Schrift-Linie“, wie in ppicng (white-black-orange …).
 */
export const FARBSCHEMATA = {
  "weiss-schwarz-orange": { titel: "Weiß · Schwarz · Orange", ppicng: "white-black-orange", hintergrund: "#ffffff", schrift: "#000000", linie: "#ff8800" },
  "schwarz-weiss-orange": { titel: "Schwarz · Weiß · Orange", ppicng: "black-white-orange", hintergrund: "#000000", schrift: "#ffffff", linie: "#ff8800" },
  "orange-weiss-lila": { titel: "Orange · Weiß · Lila", ppicng: "orange-white-purple", hintergrund: "#ff8800", schrift: "#ffffff", linie: "#652480" },
  "lila-weiss-orange": { titel: "Lila · Weiß · Orange", ppicng: "purple-white-orange", hintergrund: "#652480", schrift: "#ffffff", linie: "#ff8800" },
  "weiss-schwarz-lila": { titel: "Weiß · Schwarz · Lila", ppicng: "white-black-purple", hintergrund: "#ffffff", schrift: "#000000", linie: "#652480" },
};

export function farbschema(name) {
  const schema = FARBSCHEMATA[name] ?? Object.values(FARBSCHEMATA).find((s) => s.ppicng === name);
  if (!schema) throw new Error(`Unbekanntes Design „${name}“ – möglich: ${Object.keys(FARBSCHEMATA).join(", ")}`);
  return schema;
}

/**
 * Hell oder dunkel? Wie das Paket contrast-color in ppicng: YIQ-Helligkeit, Schwelle 180.
 * @returns {boolean} true = heller Hintergrund
 */
export function istHell(hex, schwelle = 180) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`Ungültige Farbe: ${hex}`);
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return (r * 299 + g * 587 + b * 114) / 1000 >= schwelle;
}

const SCHRIFTEN = {
  claim: "PoliticsHead.otf",
  text: "DejaRip.otf",
  fett: "DejaRip-Bold.otf",
  kursiv: "DejaRip-Italic.otf",
};

/** Schriftdateien in src/designs/*\/fonts suchen (sie liegen je Design als Kopie vor). */
function findeSchriften(dir) {
  const designs = path.join(dir, "src", "designs");
  const ergebnis = {};
  for (const design of fs.existsSync(designs) ? fs.readdirSync(designs) : []) {
    const fonts = path.join(designs, design, "fonts");
    if (!fs.existsSync(fonts)) continue;
    for (const [rolle, datei] of Object.entries(SCHRIFTEN)) {
      if (!ergebnis[rolle] && fs.existsSync(path.join(fonts, datei))) ergebnis[rolle] = path.join(fonts, datei);
    }
  }
  return ergebnis;
}

/**
 * ppicng-Checkout einlesen.
 * @returns {{dir:string, logos:Logo[], schriften:Record<string,string>}}
 * @typedef {{id:string, gruppe:string, gruppeTitel:string, titel:string, standard:string,
 *            hell?:string, dunkel?:string, ausgeschlossen:string[]}} Logo
 *   hell = Variante für helle Schrift (auf dunklem Grund), dunkel = für dunkle Schrift (auf hellem Grund)
 */
export function ladePpicng(dir) {
  const index = path.join(dir, "src", "logos", "logos.json");
  if (!fs.existsSync(index)) {
    throw new Error(`ppicng nicht gefunden unter ${dir} – im Bot-Ordner „git submodule update --init“ ausführen oder PPICNG_DIR setzen.`);
  }
  const basis = path.dirname(index);
  const datei = (rel) => (rel ? path.resolve(basis, rel) : undefined);
  const logos = [];
  for (const [gruppe, g] of Object.entries(JSON.parse(fs.readFileSync(index, "utf8")))) {
    for (const [id, l] of Object.entries(g.logos ?? {})) {
      logos.push({
        id: `${gruppe}/${id}`,
        gruppe,
        gruppeTitel: g.title ?? gruppe,
        titel: l.title ?? id,
        standard: datei(l.default),
        // In ppicng heißt die Variante nach der Schriftfarbe davor: „light“ für helle Schrift
        hell: datei(l.variants?.light),
        dunkel: datei(l.variants?.dark),
        ausgeschlossen: g.excludeFromDesigns ?? [],
      });
    }
  }
  const schriften = findeSchriften(dir);
  for (const rolle of ["claim", "text"]) {
    if (!schriften[rolle]) throw new Error(`Schrift ${SCHRIFTEN[rolle]} fehlt in ${dir}/src/designs/*/fonts.`);
  }
  schriften.fett ??= schriften.text;
  schriften.kursiv ??= schriften.text;
  return { dir, logos, schriften };
}

export function logoNachId(ppicng, id) {
  return ppicng.logos.find((l) => l.id === id) ?? null;
}

const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Logos nach Name, Gruppe oder ID suchen („bayern“, „jupi“, „nürnberg“). Genaue Treffer zuerst.
 * @returns {Logo[]}
 */
export function sucheLogos(ppicng, suche, max = 8) {
  const s = norm(suche);
  if (!s) return [];
  const woerter = s.split(" ");
  const treffer = [];
  for (const l of ppicng.logos) {
    const titel = norm(l.titel);
    const alles = `${titel} ${norm(l.id)} ${norm(l.gruppeTitel)}`;
    if (!woerter.every((w) => alles.includes(w))) continue;
    const rang = titel === s || norm(l.id) === s ? 0 : titel.startsWith(s) ? 1 : titel.includes(s) ? 2 : 3;
    treffer.push({ l, rang });
  }
  return treffer.sort((a, b) => a.rang - b.rang || a.l.titel.localeCompare(b.l.titel, "de")).slice(0, max).map((t) => t.l);
}

/**
 * Passende Logodatei für eine Schriftfarbe – wie ppicng: Ist die Schrift hell, die helle Variante,
 * sonst die dunkle; gibt es keine Varianten, das Standardlogo.
 */
export function logoDatei(logo, schriftFarbe) {
  if (!logo) return null;
  const hell = istHell(schriftFarbe);
  return (hell ? logo.hell : logo.dunkel) ?? logo.standard;
}
