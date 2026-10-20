// Texte und Knöpfe der Menüs – ohne Seiteneffekte, für Telegram und Matrix gleich.
// Knöpfe: [[{text, daten}]], daten = "<auftrag>:<aktion>[:<wert>]" (Telegram erlaubt höchstens 64 Bytes).
// Matrix zeigt sie nummeriert untereinander (höchstens 10 per Reaktion, mehr per Zahl).

import { FARBSCHEMATA, logoNachId } from "./ppicng.mjs";
import { FORMATE } from "./video.mjs";
import { zeitText, vorschlaege } from "./zeit.mjs";

export const html = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const k = (a, aktion, text, wert) => ({ text, daten: wert === undefined ? `${a.id}:${aktion}` : `${a.id}:${aktion}:${wert}` });

export const SHAREPIC_FORMATE = ["1:1", "4:5", "9:16", "16:9"];
export const BILDSTILE = {
  geteilt: "Foto neben der Textfläche",
  hintergrund: "Foto als Hintergrund",
  logo: "nur Logo aufs Foto",
};
export const LAGEN = { unten: "unten", mitte: "Mitte", oben: "oben" };

const anAus = (x) => (x ? "an" : "aus");

export function logoTitel(ppicng, id) {
  if (!id || id === "kein") return "kein Logo";
  return logoNachId(ppicng, id)?.titel ?? id;
}

/** Eine Zeile mit den wichtigsten Einstellungen. */
export function zusammenfassung(a, ctx) {
  const e = a.e;
  const teile = [`🎨 ${FARBSCHEMATA[e.design]?.titel ?? e.design}`, `🏴‍☠️ ${logoTitel(ctx.ppicng, e.logo)}`];
  if (a.art === "video") {
    teile.push(`📐 ${e.format === "original" ? "Originalformat" : e.format}`);
    if (e.untertitel) teile.push("📝 Untertitel");
    if (e.bauchbindeAn && e.bauchbinde?.name) teile.push(`🪪 ${e.bauchbinde.name}`);
    if (e.titelkarte) teile.push("🎬 Titelkarte");
    if (e.abspannAn) teile.push("🏁 Abspann");
  } else {
    teile.push(`📐 ${e.sharepicFormat}`);
    if (e.bild) teile.push(`🖼️ ${BILDSTILE[e.bildStil]}`);
  }
  return teile.join(" · ");
}

/** Hauptmenü unter der Vorschau. */
export function hauptMenu(a, ctx) {
  const zeilen = [
    `<b>${a.art === "video" ? "🎬 Video" : "🖼️ Sharepic"} fertig</b>`,
    html(zusammenfassung(a, ctx)),
    "",
    a.caption ? html(a.caption) : "<i>(noch kein Beitragstext)</i>",
  ];
  if (a.captionHinweis) zeilen.push("", `<i>${html(a.captionHinweis)}</i>`);
  if (ctx.postiz && a.kanaele) {
    const namen = ctx.kanaele.filter((c) => a.kanaele.includes(c.id)).map((c) => c.name);
    zeilen.push("", `📺 ${namen.length ? html(namen.join(", ")) : "<i>keine Kanäle gewählt</i>"}`);
  }
  const knoepfe = [];
  if (ctx.postiz) knoepfe.push([k(a, "jetzt", "✅ Jetzt posten"), k(a, "planen", "🕐 Planen")]);
  knoepfe.push([k(a, "datei", "📥 Fertige Datei"), k(a, "gestaltung", "🎨 Gestaltung")]);
  const text = [k(a, "caption", "✏️ Text ändern")];
  if (ctx.ki) text.push(k(a, "ki", "🔄 Neu formulieren"));
  knoepfe.push(text);
  if (ctx.postiz) {
    const reihe = [k(a, "kanaele", `📺 Kanäle (${a.kanaele?.length ?? 0})`)];
    if (ctx.kunden?.length) reihe.push(k(a, "kunde", "👤 Kunde"));
    knoepfe.push(reihe);
  }
  knoepfe.push([k(a, "verwerfen", "🗑️ Verwerfen")]);
  return { text: zeilen.join("\n"), knoepfe };
}

export function gestaltungMenu(a, ctx) {
  const e = a.e;
  const knoepfe = [[k(a, "design", `🎨 Design: ${FARBSCHEMATA[e.design]?.titel ?? e.design}`)], [k(a, "logo", `🏴‍☠️ Logo: ${logoTitel(ctx.ppicng, e.logo)}`)]];
  if (a.art === "video") {
    knoepfe.push([k(a, "format", `📐 Format: ${e.format === "original" ? "Original" : e.format}`)]);
    knoepfe.push([k(a, "untertitel", `📝 Untertitel: ${anAus(e.untertitel)}`), k(a, "bauchbinde", `🪪 Bauchbinde: ${anAus(e.bauchbindeAn && e.bauchbinde?.name)}`)]);
    knoepfe.push([k(a, "titelkarte", `🎬 Titelkarte: ${anAus(e.titelkarte)}`), k(a, "abspann", `🏁 Abspann: ${anAus(e.abspannAn)}`)]);
  } else {
    knoepfe.push([k(a, "format", `📐 Format: ${e.sharepicFormat}`)]);
    knoepfe.push([k(a, "claim", "💬 Claim ändern"), k(a, "erklaertext", `📄 Erklärtext: ${anAus(e.text)}`)]);
    if (e.bild) knoepfe.push([k(a, "bildstil", `🖼️ ${BILDSTILE[e.bildStil]}`)]);
  }
  knoepfe.push([k(a, "fertig", a.geaendert ? "✅ Übernehmen und neu bauen" : "⬅️ Zurück")]);
  const text = [
    "<b>🎨 Gestaltung</b>",
    "Alles im Design von ppicng – Logos, Schriften und Farben kommen direkt von dort.",
    a.geaendert ? "\n<i>Geändert – mit „Übernehmen“ wird die Vorschau neu gebaut.</i>" : "",
  ];
  if (ctx.ppicngUrl) text.push(`Eigene Grafiken (z. B. für Titelkarte und Abspann) gehen auch mit der ppicng-Web-App: ${html(ctx.ppicngUrl)}`);
  return { text: text.filter(Boolean).join("\n"), knoepfe };
}

const zurueck = (a) => [k(a, "gestaltung", "⬅️ Zurück")];

export function designMenu(a) {
  return {
    text: "<b>🎨 Design</b>\nFarbschemata wie in ppicng „classic“ (Hintergrund · Schrift · Linie):",
    knoepfe: [
      ...Object.entries(FARBSCHEMATA).map(([id, s]) => [k(a, "d", `${a.e.design === id ? "● " : ""}${s.titel}`, id)]),
      zurueck(a),
    ],
  };
}

export function logoMenu(a, ctx, treffer = null, suche = "") {
  const knoepfe = [];
  let text;
  if (treffer) {
    text = treffer.length
      ? `<b>🏴‍☠️ Logos zu „${html(suche)}“</b>\nAntippen zum Übernehmen – oder einen anderen Suchbegriff schicken.`
      : `Kein Logo zu „${html(suche)}“ gefunden. Anderen Begriff schicken, z. B. ein Bundesland, eine Stadt oder „JuPi“.`;
    for (const l of treffer) knoepfe.push([k(a, "l", `${a.e.logo === l.id ? "● " : ""}${l.titel} (${l.gruppeTitel})`, l.id)]);
  } else {
    text = `<b>🏴‍☠️ Logo</b>\nAktuell: ${html(logoTitel(ctx.ppicng, a.e.logo))}\n\nSchick mir einen Suchbegriff – z. B. <code>Bayern</code>, <code>Leipzig</code>, <code>JuPi</code> oder <code>Humanisten</code>. ` +
      `Es gibt ${ctx.ppicng.logos.length} Logos aus ppicng.`;
  }
  const standard = ctx.standardLogo;
  if (standard && standard !== a.e.logo) knoepfe.push([k(a, "l", `↩️ Standard: ${logoTitel(ctx.ppicng, standard)}`, standard)]);
  if (a.e.logo !== "kein") knoepfe.push([k(a, "l", "🚫 Ohne Logo", "kein")]);
  knoepfe.push(zurueck(a));
  return { text, knoepfe };
}

export function formatMenu(a) {
  const e = a.e;
  if (a.art === "video") {
    return {
      text: "<b>📐 Format</b>\nPasst das Video nicht genau hinein, wird es mit unscharfem Rand aufgefüllt oder zugeschnitten.",
      knoepfe: [
        ...Object.entries(FORMATE).map(([id, f]) => [k(a, "f", `${e.format === id ? "● " : ""}${f.titel}`, id)]),
        [k(a, "anpassen", e.anpassen === "zuschneiden" ? "✂️ Zuschneiden (umschalten: Rand)" : "🌫️ Unscharfer Rand (umschalten: Zuschneiden)")],
        zurueck(a),
      ],
    };
  }
  return {
    text: "<b>📐 Format</b>",
    knoepfe: [...SHAREPIC_FORMATE.map((id) => [k(a, "f", `${e.sharepicFormat === id ? "● " : ""}${FORMATE[id].titel}`, id)]), zurueck(a)],
  };
}

export function untertitelMenu(a, ctx) {
  const e = a.e;
  const knoepfe = [];
  let text = "<b>📝 Untertitel</b>\n";
  if (!ctx.whisper && !a.hatUntertitel) {
    text += "Spracherkennung ist nicht eingerichtet (WHISPER_MODELL). Du kannst aber eine <code>.srt</code>-Datei schicken.";
  } else {
    text += `Automatisch erkannt (whisper.cpp, lokal). Korrekturen als <code>falsch => richtig</code> schicken, eine pro Zeile – oder die korrigierte <code>.srt</code>-Datei.`;
    knoepfe.push([k(a, "ut", e.untertitel ? "🔇 Ausschalten" : "🔊 Einschalten", e.untertitel ? "aus" : "an")]);
    knoepfe.push([k(a, "lage", `📍 Lage: ${LAGEN[e.untertitelLage] ?? "unten"}`), k(a, "utstil", e.untertitelStil === "box" ? "▭ Stil: Fläche" : "🅰️ Stil: Kontur")]);
  }
  if (a.hatUntertitel) knoepfe.push([k(a, "srt", "📄 SRT-Datei schicken")]);
  knoepfe.push([k(a, "korrektur", "✏️ Korrigieren / SRT hochladen")]);
  knoepfe.push(zurueck(a));
  return { text, knoepfe };
}

export function bauchbindeMenu(a, ctx) {
  const e = a.e;
  const knoepfe = [];
  if (ctx.standardBauchbinde?.name && (!e.bauchbindeAn || e.bauchbinde?.name !== ctx.standardBauchbinde.name)) {
    knoepfe.push([k(a, "bb", `🪪 ${ctx.standardBauchbinde.name}`, "standard")]);
  }
  knoepfe.push([k(a, "bb", "✏️ Anderer Name …", "eingabe")]);
  if (e.bauchbindeAn) knoepfe.push([k(a, "bb", "🚫 Aus", "aus")]);
  knoepfe.push(zurueck(a));
  const aktuell = e.bauchbindeAn && e.bauchbinde?.name ? `${html(e.bauchbinde.name)}${e.bauchbinde.funktion ? ` – ${html(e.bauchbinde.funktion)}` : ""}` : "aus";
  return { text: `<b>🪪 Bauchbinde</b>\nName und Funktion, eingeblendet am Anfang.\nAktuell: ${aktuell}`, knoepfe };
}

export function karteMenu(a, ctx, art) {
  const titel = art === "titelkarte" ? "🎬 Titelkarte" : "🏁 Abspann";
  const e = a.e;
  const an = art === "titelkarte" ? Boolean(e.titelkarte) : e.abspannAn;
  const knoepfe = [];
  if (art === "abspann" && !(e.abspannAn && !e.abspann?.bild && (e.abspann?.claim ?? e.abspannText) === e.abspannText)) {
    knoepfe.push([k(a, "ab", `🏁 „${e.abspannText}“`, "standard")]);
  }
  knoepfe.push([k(a, art === "titelkarte" ? "tk" : "ab", "✏️ Text eingeben …", "text")]);
  knoepfe.push([k(a, art === "titelkarte" ? "tk" : "ab", "🖼️ Eigenes Bild schicken …", "bild")]);
  if (an) knoepfe.push([k(a, art === "titelkarte" ? "tk" : "ab", "🚫 Aus", "aus")]);
  knoepfe.push(zurueck(a));
  const beschreibung = art === "titelkarte"
    ? "Eine Karte im ppicng-Design vor dem Video: großer Claim mit Linie, Logo darunter."
    : "Eine Karte im ppicng-Design nach dem Video, z. B. mit eurer Webadresse.";
  let text = `<b>${titel}</b>\n${beschreibung}`;
  if (ctx.ppicngUrl) text += `\nOder ein fertiges Sharepic aus der ppicng-Web-App schicken: ${html(ctx.ppicngUrl)}`;
  return { text, knoepfe };
}

export function bildstilMenu(a) {
  return {
    text: "<b>🖼️ Foto</b>",
    knoepfe: [...Object.entries(BILDSTILE).map(([id, t]) => [k(a, "bs", `${a.e.bildStil === id ? "● " : ""}${t}`, id)]), zurueck(a)],
  };
}

export function kanaeleMenu(a, ctx) {
  const liste = ctx.kanaeleAuswahl;
  const knoepfe = liste.map((c) => [k(a, "k", `${a.kanaele.includes(c.id) ? "✅" : "⬜"} ${c.name} (${c.identifier})`, c.id)]);
  knoepfe.push([k(a, "menu", "✔️ Fertig")]);
  return { text: "<b>📺 Kanäle</b>\nAntippen zum An- und Abwählen.", knoepfe };
}

export function kundeMenu(a, ctx) {
  const knoepfe = ctx.kunden.map((c) => [k(a, "ku", `${a.kunde === c.id ? "● " : ""}${c.name}`, c.id)]);
  knoepfe.push([k(a, "ku", `${a.kunde ? "" : "● "}Alle Kanäle`, "alle")]);
  knoepfe.push([k(a, "menu", "⬅️ Zurück")]);
  return { text: "<b>👤 Kunde</b>\nIn Postiz sind Kanäle Kunden zugeordnet, z. B. einer Gliederung.", knoepfe };
}

export function planenMenu(a, jetzt = new Date()) {
  const knoepfe = vorschlaege(jetzt).map(([t, d]) => [k(a, "z", t, String(d.getTime()))]);
  knoepfe.push([k(a, "slot", "🗓️ Nächster freier Postiz-Slot")]);
  knoepfe.push([k(a, "menu", "⬅️ Zurück")]);
  return {
    text: "<b>🕐 Planen</b>\nVorschlag antippen oder eine Zeit schicken, z. B. <code>Fr 18 Uhr</code>, <code>24.10. 19:30</code>, <code>in 2 Stunden</code>.",
    knoepfe,
  };
}

export function bestaetigenMenu(a, ctx, zeit) {
  const namen = ctx.kanaele.filter((c) => a.kanaele.includes(c.id)).map((c) => c.name).join(", ");
  const wann = zeit ? `am ${zeitText(zeit)}` : "jetzt";
  return {
    text: `Wirklich ${wann} auf ${html(namen)} posten?`,
    knoepfe: [[k(a, "ja", "✅ Ja", zeit ? String(zeit.getTime()) : "jetzt"), k(a, "menu", "❌ Nein")]],
  };
}

export function hilfe(ctx) {
  const p = ctx.plattform === "matrix" ? "!" : "/";
  const zeilen = [
    "<b>🏴‍☠️ Piraten-Posting-Bot</b>",
    "Einheitliches Design für Videos und Sharepics – mit Logos, Schriften und Farben aus ppicng.",
    "",
    "🎬 <b>Video schicken</b> → Format, Logo, Untertitel, Bauchbinde, Titelkarte und Abspann im ppicng-Design",
    `🖼️ <b>${p}sharepic Claim</b> → Sharepic wie aus ppicng (zweite Zeile = Erklärtext)`,
    "📷 <b>Foto schicken</b> → Sharepic mit Foto (Bildunterschrift = Claim) oder Foto mit Logo",
    `🔎 <b>${p}logo Bayern</b> → Logos aus ppicng suchen`,
    `ℹ️ <b>${p}status</b> · <b>${p}id</b> · <b>${p}abbrechen</b>`,
  ];
  if (ctx.plattform === "matrix") zeilen.push("", "Auswahl: Reaktion 1️⃣ 2️⃣ 3️⃣ … antippen oder die Zahl schicken.");
  if (ctx.plattform === "telegram") zeilen.push("", "Videos am besten <b>als Datei</b> schicken (📎 → Datei), sonst komprimiert Telegram sie.");
  zeilen.push(ctx.postiz ? "Posten und Planen geht über Postiz." : "Postiz ist nicht angebunden – die fertige Datei gibt es mit „📥 Fertige Datei“.");
  if (ctx.ppicngUrl) zeilen.push(`ppicng im Browser: ${html(ctx.ppicngUrl)}`);
  return zeilen.join("\n");
}
