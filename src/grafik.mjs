// Grafiken im Stil von ppicng „classic“, gezeichnet mit @napi-rs/canvas (ohne Browser, läuft auf dem Pi):
//   • Sharepic / Titelkarte / Abspann: Fläche im Farbschema, Claim in Politics Head mit Linie darunter,
//     optional Erklärtext in DejaRip, Logo unten (27 % der Höhe) – wie src/designs/classic/components/Overlay.tsx
//   • Logo-Plakette für Videos: Logo auf einer Fläche im Farbschema mit Linie
//   • Bauchbinde: Name in Politics Head mit Linie, Funktion in DejaRip
// Die Schrift wird so groß wie möglich in die Fläche eingepasst (Nachbau von AutoScaleText.tsx).

import fs from "node:fs";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { logoDatei } from "./ppicng.mjs";

export const gerade = (n) => Math.max(2, Math.round(n / 2) * 2);

export const SCHRIFT = { claim: "PPIC Claim", text: "PPIC Text", fett: "PPIC Text Fett" };

let registriert = null;
/** Schriften aus ppicng einmalig bei canvas anmelden. */
export function schriftenAnmelden(ppicng) {
  if (registriert === ppicng.dir) return;
  GlobalFonts.registerFromPath(ppicng.schriften.claim, SCHRIFT.claim);
  GlobalFonts.registerFromPath(ppicng.schriften.text, SCHRIFT.text);
  GlobalFonts.registerFromPath(ppicng.schriften.fett, SCHRIFT.fett);
  registriert = ppicng.dir;
}

/**
 * Text in Zeilen umbrechen (an Leerzeichen, Zeilenumbrüche bleiben).
 * @param {(t:string)=>number} breiteVon Textbreite bei der aktuellen Schriftgröße
 */
export function umbrechenAufBreite(text, maxBreite, breiteVon) {
  const zeilen = [];
  for (const absatz of String(text).split("\n")) {
    let zeile = "";
    for (const wort of absatz.split(/\s+/).filter(Boolean)) {
      const probe = zeile ? `${zeile} ${wort}` : wort;
      if (zeile && breiteVon(probe) > maxBreite) {
        zeilen.push(zeile);
        zeile = wort;
      } else {
        zeile = probe;
      }
    }
    zeilen.push(zeile);
  }
  return zeilen.map((t) => ({ text: t, breite: breiteVon(t) }));
}

/** Höhe des Textblocks wie in ppicng: n Zeilen × Schriftgröße, Zeilenabstand dazwischen. */
export const blockHoehe = (n, groesse, zeilenhoehe) => groesse * (1 + (n - 1) * zeilenhoehe);

/**
 * Größte Schriftgröße, bei der der Text in die Fläche passt – samt Linie darunter
 * (Linie: 1/7 der Schriftgröße hoch, 1/5 Abstand, wie AutoScaleText „eline“).
 * @param {(t:string, groesse:number)=>number} messen
 * @returns {{groesse:number, zeilen:{text:string,breite:number}[], hoehe:number}}
 */
export function einpassen(text, { breite, hoehe, zeilenhoehe = 1, linie = false, maxGroesse = Infinity, messen }) {
  const layout = (g) => {
    const zeilen = umbrechenAufBreite(text, breite, (t) => messen(t, g));
    const h = blockHoehe(zeilen.length, g, zeilenhoehe) + (linie ? g / 7 + g / 5 : 0);
    return { groesse: g, zeilen, hoehe: h, passt: h <= hoehe && zeilen.every((z) => z.breite <= breite) };
  };
  let lo = 1;
  let hi = Math.max(2, Math.min(hoehe, maxGroesse));
  if (layout(hi).passt) return layout(hi);
  for (let i = 0; i < 24 && hi - lo > 0.5; i++) {
    const mitte = (lo + hi) / 2;
    if (layout(mitte).passt) lo = mitte;
    else hi = mitte;
  }
  const { passt, ...ergebnis } = layout(Math.floor(lo));
  return ergebnis;
}

const messerFuer = (ctx, schrift) => (t, g) => {
  ctx.font = `${g}px "${schrift}"`;
  return ctx.measureText(t).width;
};

/**
 * Text eingepasst zeichnen. valign: oben | mitte | unten. Gibt die Unterkante zurück.
 */
export function zeichneText(ctx, text, { x, y, breite, hoehe, schrift, farbe, zeilenhoehe = 1, linie, valign = "oben", align = "links", maxGroesse }) {
  if (!String(text).trim()) return y;
  const l = einpassen(text, { breite, hoehe, zeilenhoehe, linie: Boolean(linie), maxGroesse, messen: messerFuer(ctx, schrift) });
  const oben = y + (valign === "unten" ? hoehe - l.hoehe : valign === "mitte" ? (hoehe - l.hoehe) / 2 : 0);
  ctx.font = `${l.groesse}px "${schrift}"`;
  ctx.fillStyle = farbe;
  ctx.textBaseline = "top";
  const zx = (z) => (align === "mitte" ? x + (breite - z.breite) / 2 : align === "rechts" ? x + breite - z.breite : x);
  for (const [i, z] of l.zeilen.entries()) ctx.fillText(z.text, zx(z), oben + i * l.groesse * zeilenhoehe);
  let unten = oben + blockHoehe(l.zeilen.length, l.groesse, zeilenhoehe);
  if (linie) {
    const letzte = l.zeilen.at(-1);
    const ly = unten + l.groesse / 5;
    ctx.fillStyle = linie;
    ctx.fillRect(zx(letzte), ly, letzte.breite, l.groesse / 7);
    unten = ly + l.groesse / 7;
  }
  return unten;
}

/**
 * CSS-Klassen eines SVG (<style>.st0{…}</style>, wie Illustrator sie schreibt) in style-Attribute
 * umschreiben – der SVG-Renderer von canvas kennt keine Stylesheets und malte sonst alles schwarz.
 */
export function svgOhneKlassen(svg) {
  const regeln = {};
  const ohneStyle = svg.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css) => {
    for (const [, namen, decl] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const n of namen.split(",")) {
        const k = n.trim().replace(/^\./, "");
        regeln[k] = (regeln[k] ?? "") + decl.trim().replace(/;?$/, ";");
      }
    }
    return "";
  });
  return ohneStyle.replace(/<[^!?/][^>]*\sclass="([^"]*)"[^>]*>/g, (tag, klassen) => {
    const css = klassen.split(/\s+/).map((k) => regeln[k] ?? "").join("");
    const ohneKlasse = tag.replace(/\sclass="[^"]*"/, "");
    return /\sstyle="/.test(ohneKlasse)
      ? ohneKlasse.replace(/\sstyle="/, ` style="${css}`)
      : ohneKlasse.replace(/^<([^\s>/]+)/, `<$1 style="${css}"`);
  });
}

const bildCache = new Map();
export async function ladeBild(datei) {
  if (!bildCache.has(datei)) {
    const inhalt = fs.readFileSync(datei);
    const daten = /\.svg$/i.test(datei) ? Buffer.from(svgOhneKlassen(inhalt.toString("utf8"))) : inhalt;
    bildCache.set(datei, await loadImage(daten));
  }
  return bildCache.get(datei);
}

/** Bild in eine Fläche setzen: fit = ganz sichtbar, mittig; fill = Fläche füllen, mittig beschnitten. */
export function zeichneBild(ctx, bild, { x, y, breite, hoehe, art = "fit" }) {
  const ratio = breite / hoehe;
  const bildRatio = bild.width / bild.height;
  const groesser = art === "fill" ? ratio > bildRatio : ratio < bildRatio;
  const w = groesser ? breite : hoehe * bildRatio;
  const h = groesser ? breite / bildRatio : hoehe;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, breite, hoehe);
  ctx.clip();
  ctx.drawImage(bild, x + (breite - w) / 2, y + (hoehe - h) / 2, w, h);
  ctx.restore();
  return { x: x + (breite - w) / 2, y: y + (hoehe - h) / 2, breite: w, hoehe: h };
}

/**
 * Sharepic, Titelkarte oder Abspann im ppicng-„classic“-Layout.
 * @param {object} o
 * @param {number} o.breite
 * @param {number} o.hoehe
 * @param {object} o.schema Farbschema (FARBSCHEMATA)
 * @param {string} o.claim großer Text, darunter die Linie
 * @param {string} [o.text] Erklärtext
 * @param {object} [o.logo] Logo aus ppicng
 * @param {string} [o.bild] Foto; liegt dann neben/über der Textfläche (ppicng „sidebyside“)
 * @param {"oben"|"links"|"hintergrund"} [o.bildPosition] Standard: oben bei Hoch-/Quadratformat, links bei Querformat
 * @returns {Promise<Buffer>} PNG
 */
export async function sharepic({ breite, hoehe, schema, claim, text = "", logo = null, bild = null, bildPosition }) {
  const canvas = createCanvas(breite, hoehe);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, breite, hoehe);

  // Fläche für Text und Logo – mit Foto die halbe Seite, sonst alles
  let f = { x: 0, y: 0, breite, hoehe };
  let deckkraft = 1;
  if (bild) {
    const foto = await ladeBild(bild);
    const pos = bildPosition ?? (breite > hoehe ? "links" : "oben");
    if (pos === "links") {
      zeichneBild(ctx, foto, { x: 0, y: 0, breite: breite / 2, hoehe, art: "fill" });
      f = { x: breite / 2, y: 0, breite: breite / 2, hoehe };
    } else if (pos === "oben") {
      zeichneBild(ctx, foto, { x: 0, y: 0, breite, hoehe: hoehe / 2, art: "fill" });
      f = { x: 0, y: hoehe / 2, breite, hoehe: hoehe / 2 };
    } else {
      zeichneBild(ctx, foto, { x: 0, y: 0, breite, hoehe, art: "fill" });
      deckkraft = 0.75;
    }
  }
  ctx.globalAlpha = deckkraft;
  ctx.fillStyle = schema.hintergrund;
  ctx.fillRect(f.x, f.y, f.breite, f.hoehe);
  ctx.globalAlpha = 1;

  // Aufteilung wie Overlay.tsx: Rand (b+h)/40, Logo 27 %, Claim 50 % (mit Erklärtext) bzw. der Rest
  const rand = (f.breite + f.hoehe) / 40;
  const b = { x: f.x + rand, y: f.y + rand, breite: f.breite - 2 * rand, hoehe: f.hoehe - 2 * rand };
  const logoAnteil = logo ? 0.27 : 0;
  const claimAnteil = text ? 0.5 : 1 - logoAnteil;
  const politics = { schrift: SCHRIFT.claim, zeilenhoehe: 0.9 };
  zeichneText(ctx, claim, {
    x: b.x, y: b.y, breite: b.breite, hoehe: claimAnteil * b.hoehe,
    ...politics, farbe: schema.schrift, linie: schema.linie, valign: text ? "unten" : "mitte",
  });
  if (text) {
    zeichneText(ctx, text, {
      x: b.x, y: b.y + claimAnteil * b.hoehe + rand / 2, breite: b.breite,
      hoehe: (1 - claimAnteil - logoAnteil) * b.hoehe - rand / 2,
      schrift: SCHRIFT.text, farbe: schema.schrift, maxGroesse: b.hoehe / 9,
    });
  }
  if (logo) {
    const lb = await ladeBild(logoDatei(logo, schema.schrift));
    zeichneBild(ctx, lb, {
      x: b.x + 0.05 * b.breite, y: b.y + b.hoehe * (1 - logoAnteil) + rand / 2,
      breite: 0.9 * b.breite, hoehe: logoAnteil * b.hoehe - rand / 2,
    });
  }
  return canvas.encode("png");
}

/**
 * Logo für Videos und Fotos.
 * „auto“: ohne Fläche, die Farbe richtet sich nach dem Hintergrund – auf hellem (`hell`) das dunkle Logo mit
 * hellem Schein, sonst das helle mit Schatten. „frei“: immer das helle Logo mit Schatten.
 * „plakette“: kompakte, abgerundete Fläche im Farbschema mit Linie unten (wie die Claim-Linie).
 * Bei „auto“ sind die Maße unabhängig von `hell` – die Lage lässt sich also vorher berechnen.
 * @param {number} logoBreite Breite des Logos in Pixeln
 * @returns {Promise<{png:Buffer, breite:number, hoehe:number}>}
 */
export async function logoPlakette({ logo, schema, logoBreite, stil = "auto", hell = false }) {
  const frei = stil !== "plakette";
  const dunkel = stil === "auto" && hell;
  const bild = await ladeBild(logoDatei(logo, frei ? (dunkel ? "#000000" : "#ffffff") : schema.schrift));
  const lw = Math.round(logoBreite);
  const lh = Math.round((lw * bild.height) / bild.width);
  // Die Logo-PNGs aus ppicng haben selbst schon Luft um das Logo – die Plakette braucht kaum eigenen Rand
  const innen = frei ? Math.round(lw * 0.04) : Math.round(lw * 0.012);
  const linie = frei ? 0 : Math.max(2, Math.round(lw * 0.02));
  const breite = gerade(lw + 2 * innen);
  const hoehe = gerade(lh + 2 * innen + linie);
  const canvas = createCanvas(breite, hoehe);
  const ctx = canvas.getContext("2d");
  if (frei) {
    ctx.shadowColor = dunkel ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.55)";
    ctx.shadowBlur = innen * 0.8;
    // Der helle Schein braucht zwei Lagen, um auf unruhigem Grund zu tragen
    if (dunkel) ctx.drawImage(bild, innen, innen, lw, lh);
  } else {
    ctx.beginPath();
    ctx.roundRect(0, 0, breite, hoehe, Math.round(lw * 0.04));
    ctx.clip();
    ctx.fillStyle = schema.hintergrund;
    ctx.fillRect(0, 0, breite, hoehe);
    ctx.fillStyle = schema.linie;
    ctx.fillRect(0, hoehe - linie, breite, linie);
  }
  ctx.drawImage(bild, innen, innen, lw, lh);
  return { png: await canvas.encode("png"), breite, hoehe };
}

/** Ab dieser mittleren Helligkeit (0–255) gilt der Grund hinter dem Logo als hell. */
export const HELL_AB = 150;

/** Mittlere Helligkeit eines Bereichs auf einer Canvas (Rec. 601). */
export function helligkeit(ctx, { x, y, breite, hoehe }) {
  const d = ctx.getImageData(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.max(1, Math.round(breite)), Math.max(1, Math.round(hoehe))).data;
  let summe = 0;
  for (let i = 0; i < d.length; i += 4) summe += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return summe / (d.length / 4);
}

/**
 * Bauchbinde: Name groß in Politics Head mit Linie, Funktion darunter in DejaRip, auf einer Fläche
 * im Farbschema. `einheit` = Schriftgröße des Namens in Pixeln.
 * @returns {Promise<{png:Buffer, breite:number, hoehe:number}>}
 */
export async function bauchbinde({ name, funktion = "", schema, einheit, maxBreite }) {
  const probe = createCanvas(10, 10).getContext("2d");
  const messen = messerFuer(probe, SCHRIFT.claim);
  const messenText = messerFuer(probe, SCHRIFT.text);
  const innen = Math.round(einheit * 0.45);
  // Zu lange Namen schrumpfen, bis sie in die Breite passen
  let g = einheit;
  const fg = () => Math.round(g * 0.48);
  const textBreite = () => Math.max(messen(name, g), funktion ? messenText(funktion, fg()) : 0);
  while (g > 8 && textBreite() + 2 * innen > maxBreite) g -= 1;
  const linie = g / 7;
  const breite = gerade(Math.min(maxBreite, textBreite() + 2 * innen));
  const nameHoehe = g + g / 5 + linie;
  const hoehe = gerade(innen + nameHoehe + (funktion ? g * 0.35 + fg() * 1.15 : 0) + innen * 0.85);
  const canvas = createCanvas(breite, hoehe);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = schema.hintergrund;
  ctx.fillRect(0, 0, breite, hoehe);
  ctx.textBaseline = "top";
  ctx.fillStyle = schema.schrift;
  ctx.font = `${g}px "${SCHRIFT.claim}"`;
  ctx.fillText(name, innen, innen);
  ctx.fillStyle = schema.linie;
  ctx.fillRect(innen, innen + g + g / 5, messen(name, g), linie);
  if (funktion) {
    ctx.fillStyle = schema.schrift;
    ctx.font = `${fg()}px "${SCHRIFT.text}"`;
    ctx.fillText(funktion, innen, innen + nameHoehe + g * 0.35);
  }
  return { png: await canvas.encode("png"), breite, hoehe };
}


// ---------- Lage auf der Fläche ----------

/**
 * Ränder: 5 % der kurzen Seite. Hochkant-Videos: Reels/TikTok blenden oben gut 10 % Reiter und Kamera
 * ein – dort beginnt das Logo erst bei 14 % der Höhe (bei Fotos genügen 7,3 %).
 */
export function raender(masse, video = true) {
  const rand = Math.round(Math.min(masse.breite, masse.hoehe) * 0.05);
  const hochkant = masse.hoehe > masse.breite;
  return { rand, oben: hochkant ? Math.round(masse.hoehe * (video ? 0.14 : 0.073)) : rand };
}

export function logoLage({ masse, grafik, position = "oben-links", video = true }) {
  const { rand, oben } = raender(masse, video);
  return {
    x: position.includes("rechts") ? masse.breite - rand - grafik.breite : rand,
    y: position.includes("unten") ? masse.hoehe - rand - grafik.hoehe : oben,
  };
}

/** Eigenes Bild (z. B. aus der ppicng-Web-App) ganz sichtbar auf die Fläche, Rest im Hintergrund des Designs. */
export async function eigenesBild({ breite, hoehe, bild, schema }) {
  const canvas = createCanvas(breite, hoehe);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = schema.hintergrund;
  ctx.fillRect(0, 0, breite, hoehe);
  zeichneBild(ctx, await ladeBild(bild), { x: 0, y: 0, breite, hoehe, art: "fit" });
  return canvas.encode("png");
}

/** Foto auf die Fläche (füllend, mittig beschnitten) mit Logo. */
export async function fotoMitLogo({ breite, hoehe, bild, logo, schema, logoBreite, stil, position }) {
  const canvas = createCanvas(breite, hoehe);
  const ctx = canvas.getContext("2d");
  zeichneBild(ctx, await ladeBild(bild), { x: 0, y: 0, breite, hoehe, art: "fill" });
  if (logo) {
    const o = { logo, schema, logoBreite: Math.min(breite, hoehe) * logoBreite, stil };
    let g = await logoPlakette(o);
    const { x, y } = logoLage({ masse: { breite, hoehe }, grafik: g, position, video: false });
    if (stil === "auto" && helligkeit(ctx, { x, y, breite: g.breite, hoehe: g.hoehe }) >= HELL_AB) g = await logoPlakette({ ...o, hell: true });
    ctx.drawImage(await loadImage(g.png), x, y);
  }
  return canvas.encode("png");
}
