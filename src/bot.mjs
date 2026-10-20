// Piraten-Posting-Bot: Videos und Sharepics im einheitlichen ppicng-Design, gesteuert über Telegram
// und/oder Matrix und über die Web-Version, gepostet über Postiz (optional). Start: npm start

import fs from "node:fs";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { ladeConfig, chatStandard } from "./config.mjs";
import { TelegramPlattform } from "./plattform/telegram.mjs";
import { MatrixPlattform } from "./plattform/matrix.mjs";
import { ladePpicng, sucheLogos } from "./ppicng.mjs";
import { schriftenAnmelden } from "./grafik.mjs";
import { ausfuehren, fotoNormalisieren, sichereEndung } from "./video.mjs";
import { parseKorrekturen, parseBauchbinde } from "./untertitel.mjs";
import { kuerzen } from "./caption.mjs";
import { kundenAus, zeichenLimit, zeichenZahl } from "./postiz.mjs";
import { erwartetePosts, faelligeKontrollen, abfragezeitraum, auswerten } from "./kontrolle.mjs";
import { parseZeit, zeitText } from "./zeit.mjs";
import { Werkstatt } from "./werkstatt.mjs";
import { starteWeb } from "./web.mjs";
import * as M from "./menues.mjs";

const html = M.html;
const config = ladeConfig();
const ppicng = ladePpicng(config.ppicng.dir);
schriftenAnmelden(ppicng);
const werkstatt = new Werkstatt({ config, ppicng });
const { auftraege, postiz, zaehler } = werkstatt;

/** @type {Record<string, TelegramPlattform|MatrixPlattform>} */
const plattformen = {};
if (config.telegram) plattformen.telegram = new TelegramPlattform(config.telegram);
if (config.matrix) plattformen.matrix = new MatrixPlattform(config.matrix, config.datenDir);

const chatKey = (plattform, chat) => `${plattform}|${chat}`;
const von = (a) => plattformen[a.plattform];
const arbeit = (fn) => werkstatt.arbeit(fn);
const alleKanaele = () => werkstatt.alleKanaele();
const standardKanaele = (a) => werkstatt.standardKanaele(a);

// ---------- Kontext für die Menüs ----------

async function kontext(a) {
  const std = chatStandard(config, a.chat);
  const ctx = {
    ppicng,
    plattform: a.plattform,
    postiz: Boolean(postiz),
    ki: Boolean(config.caption.anbieter),
    whisper: Boolean(config.whisper),
    gesicht: werkstatt.gesichtAktiv,
    ppicngUrl: config.ppicng.url,
    webUrl: config.web?.url,
    standardLogo: std.logo,
    standardBauchbinde: std.bauchbinde,
    kanaele: [],
    kunden: [],
  };
  if (postiz) {
    try {
      const alle = await alleKanaele();
      ctx.kanaele = alle;
      ctx.kunden = kundenAus(alle);
      ctx.kanaeleAuswahl = await werkstatt.kanaeleFuer(a);
    } catch (e) {
      ctx.postizFehler = e.message;
    }
  }
  return ctx;
}

async function menuZeigen(a, menu, { neu = false } = {}) {
  const p = von(a);
  const { text, knoepfe } = menu;
  if (!neu && a.menu) {
    const id = await p.bearbeiten(a.chat, a.menu, text, { knoepfe });
    if (id !== a.menu) auftraege.aendern(a.id, { menu: id });
  } else {
    auftraege.aendern(a.id, { menu: await p.senden(a.chat, text, { knoepfe }) });
  }
}

async function hauptmenu(a, o) {
  // Einmal-Schlüssel für „Im Browser schneiden“: Der Beitrag zieht dann in die Web-Version um
  if (config.web?.url && !a.freigabe) auftraege.aendern(a.id, { freigabe: crypto.randomBytes(16).toString("hex") });
  await menuZeigen(a, M.hauptMenu(a, await kontext(a)), o);
}

// ---------- Neuer Auftrag ----------

function neuerAuftrag(ereignis, art) {
  return werkstatt.neu({ plattform: ereignis.plattform, chat: ereignis.chat, art, von: ereignis.nutzerName });
}

async function status(a, text) {
  const p = von(a);
  if (a.statusNachricht) {
    try {
      await p.bearbeiten(a.chat, a.statusNachricht, text);
      return;
    } catch {}
  }
  auftraege.aendern(a.id, { statusNachricht: await p.senden(a.chat, text) });
}

const schlangenHinweis = () => (werkstatt.wartend > 0 ? ` (in der Warteschlange: ${werkstatt.wartend} vor dir)` : "");

async function videoEmpfangen(ereignis) {
  const p = plattformen[ereignis.plattform];
  const a = neuerAuftrag(ereignis, "video");
  await status(a, `⏳ Video angekommen – ich lade es${schlangenHinweis()} …`);
  try {
    const original = path.join(a.ordner, `original${sichereEndung(ereignis.medium.name, "video")}`);
    await p.herunterladen(ereignis.medium, original);
    await werkstatt.videoAnnehmen(a, original, ereignis.text);
    await arbeit(async () => {
      const warnungen = await werkstatt.analysieren(a, (t) => status(a, t));
      for (const w of warnungen) await p.senden(a.chat, `⚠️ ${html(w)}`);
      await werkstatt.captionErzeugen(a);
      await werkstatt.bauen(a, (t) => status(a, t));
    });
    await werkstatt.kanaeleVorwaehlen(a);
    await zeigen(a);
  } catch (e) {
    await fehlschlag(a, e);
  }
}

async function fotoEmpfangen(ereignis, fuer = null) {
  const p = plattformen[ereignis.plattform];
  const roh = path.join(config.datenDir, `eingang-${Date.now()}${sichereEndung(ereignis.medium.name, "bild")}`);
  await p.herunterladen(ereignis.medium, roh);
  if (fuer) {
    // Bild für Titelkarte, Abspann oder ein bestehendes Sharepic
    const ziel = path.join(fuer.a.ordner, `${fuer.zweck}-${Date.now()}.png`);
    await fotoNormalisieren(roh, ziel);
    await fsp.rm(roh, { force: true });
    return ziel;
  }
  const a = neuerAuftrag(ereignis, "sharepic");
  const bild = path.join(a.ordner, "foto.png");
  await fotoNormalisieren(roh, bild);
  await fsp.rm(roh, { force: true });
  const [claim, ...rest] = (ereignis.text ?? "").replace(/^[/!]sharepic\s*/i, "").split("\n");
  a.e.bild = bild;
  a.e.claim = claim.trim();
  a.e.text = rest.join("\n").trim();
  a.e.bildStil = a.e.claim ? "geteilt" : "logo";
  auftraege.aendern(a.id, { e: a.e });
  await sharepicStarten(a);
}

async function sharepicEmpfangen(ereignis, eingabe) {
  const a = neuerAuftrag(ereignis, "sharepic");
  const [claim, ...rest] = eingabe.split(/\n|\s\|\s/);
  a.e.claim = claim.trim();
  a.e.text = rest.join("\n").trim();
  auftraege.aendern(a.id, { e: a.e });
  await sharepicStarten(a);
}

async function sharepicStarten(a) {
  try {
    await werkstatt.captionErzeugen(a);
    await werkstatt.bauen(a);
    await werkstatt.kanaeleVorwaehlen(a);
    await zeigen(a);
  } catch (e) {
    await fehlschlag(a, e);
  }
}

async function fehlschlag(a, e) {
  console.error(`Auftrag ${a.id}:`, e);
  auftraege.aendern(a.id, { status: "fehler" });
  await von(a).senden(a.chat, `❌ Das hat nicht geklappt:\n<code>${html(e.message).slice(0, 1500)}</code>`).catch(() => {});
}

/** Vorschau schicken, darunter das Hauptmenü. */
async function zeigen(a) {
  const p = von(a);
  if (a.statusNachricht) {
    await p.bearbeiten(a.chat, a.statusNachricht, "✅ Fertig – hier die Vorschau:").catch(() => {});
    auftraege.aendern(a.id, { statusNachricht: null });
  }
  if (a.art === "video") await p.video(a.chat, a.vorschauDatei, { ...a.masse, dauer: a.dauer });
  else await p.bild(a.chat, a.vorschauDatei);
  await hauptmenu(a, { neu: true });
}

async function neuBauen(a) {
  auftraege.aendern(a.id, { status: "arbeitet" });
  try {
    await arbeit(() => werkstatt.bauen(a, (t) => status(a, t)));
    await zeigen(a);
  } catch (e) {
    await fehlschlag(a, e);
  }
}

// ---------- Posten ----------

async function posten(a, zeit) {
  const p = von(a);
  const kanaele = (await alleKanaele()).filter((c) => a.kanaele.includes(c.id));
  if (!kanaele.length) return p.senden(a.chat, "Keine Kanäle gewählt – unter 📺 Kanäle auswählen.");
  const probleme = werkstatt.zuLang(a, kanaele);
  if (probleme) {
    return menuZeigen(a, {
      text: `✂️ Der Text ist zu lang für:\n${probleme.map((x) => `• ${html(x.c.name)}: ${x.n}/${x.max}`).join("\n")}`,
      knoepfe: [[{ text: "✂️ Automatisch kürzen", daten: `${a.id}:kuerzen` }], [{ text: "✏️ Text ändern", daten: `${a.id}:caption` }], [{ text: "⬅️ Zurück", daten: `${a.id}:menu` }]],
    });
  }
  const frei = werkstatt.wiederFrei(a);
  if (frei) {
    return p.senden(a.chat, frei === Infinity
      ? "Postiz-Anfragenlimit zu klein für diesen Beitrag (POSTIZ_MAX_ANFRAGEN)."
      : `⏳ Postiz-Anfragenlimit für diese Stunde erreicht – wieder frei ab ${zeitText(frei)}.`);
  }
  auftraege.aendern(a.id, { status: "arbeitet" });
  await status(a, "📤 Lade zu Postiz hoch …");
  try {
    await werkstatt.posten(a, zeit);
    auftraege.aendern(a.id, { statusNachricht: null });
    await menuZeigen(a, {
      text: zeit
        ? `🕐 Geplant für ${zeitText(zeit)} auf ${html(kanaele.map((c) => c.name).join(", "))}. Ändern geht im Postiz-Kalender.`
        : `✅ Gepostet auf ${html(kanaele.map((c) => c.name).join(", "))}. Ich schaue in 15 Minuten nach, ob Postiz alles veröffentlicht hat.`,
      knoepfe: [[{ text: "📥 Fertige Datei", daten: `${a.id}:datei` }]],
    });
  } catch (e) {
    // Nochmal versuchen soll möglich bleiben
    console.error(`Auftrag ${a.id}: Posten`, e);
    auftraege.aendern(a.id, { status: "bereit", statusNachricht: null });
    await p.senden(a.chat, `❌ Postiz hat nicht mitgespielt:\n<code>${html(e.message).slice(0, 1500)}</code>`);
    await hauptmenu(a, { neu: true });
  }
}

// ---------- Knöpfe ----------

async function knopf(ereignis) {
  const [id, aktion, wert] = ereignis.daten.split(":");
  const wertRest = ereignis.daten.split(":").slice(2).join(":");
  const a = auftraege.get(id);
  const p = plattformen[ereignis.plattform];
  if (!a || a.chat !== ereignis.chat) return p.senden(ereignis.chat, "Diesen Beitrag gibt es nicht mehr.");
  if (["gepostet", "geplant", "verworfen"].includes(a.status) && aktion !== "datei") {
    return p.senden(ereignis.chat, `Dieser Beitrag ist schon ${a.status}.`);
  }
  if (a.status === "arbeitet" && aktion !== "datei") return p.senden(ereignis.chat, "⏳ Moment, ich bin noch dran …");
  // Menü gilt ab jetzt als das zuletzt bediente
  if (ereignis.nachricht && ereignis.nachricht !== a.menu) auftraege.aendern(a.id, { menu: ereignis.nachricht });
  auftraege.aendern(a.id, { wartetAuf: null });
  const ctx = await kontext(a);
  const e = a.e;
  const aendern = async (felder, menu = "gestaltung") => {
    Object.assign(e, felder);
    auftraege.aendern(a.id, { e, geaendert: true });
    if (menu === "gestaltung") await menuZeigen(a, M.gestaltungMenu(a, ctx));
    else await menuZeigen(a, menu);
  };
  const warte = async (art, text, knoepfe = [[{ text: "⬅️ Zurück", daten: `${a.id}:gestaltung` }]]) => {
    auftraege.aendern(a.id, { wartetAuf: art });
    await menuZeigen(a, { text, knoepfe });
  };

  switch (aktion) {
    case "menu":
      return hauptmenu(a);
    case "gestaltung":
      return menuZeigen(a, M.gestaltungMenu(a, ctx));
    case "fertig":
      if (a.geaendert) {
        await menuZeigen(a, { text: "🔁 Baue neu …", knoepfe: [] });
        auftraege.aendern(a.id, { menu: null });
        return neuBauen(a);
      }
      return hauptmenu(a);

    case "design":
      return menuZeigen(a, M.designMenu(a));
    case "d":
      return aendern({ design: wert });
    case "logo":
      auftraege.aendern(a.id, { wartetAuf: "logo" });
      return menuZeigen(a, M.logoMenu(a, ctx));
    case "l":
      return aendern({ logo: wertRest });
    case "format":
      return menuZeigen(a, M.formatMenu(a));
    case "f":
      return aendern(a.art === "video" ? { format: wertRest } : { sharepicFormat: wertRest });
    case "anpassen":
      Object.assign(e, { anpassen: e.anpassen === "zuschneiden" ? "rand" : "zuschneiden" });
      auftraege.aendern(a.id, { e, geaendert: true });
      return menuZeigen(a, M.formatMenu(a));

    case "untertitel":
      return menuZeigen(a, M.untertitelMenu(a, ctx));
    case "ut":
      Object.assign(e, { untertitel: wert === "an" });
      auftraege.aendern(a.id, { e, geaendert: true });
      return menuZeigen(a, M.untertitelMenu(a, ctx));
    case "lage": {
      const lagen = Object.keys(M.LAGEN).filter((l) => l !== "auto" || ctx.gesicht);
      Object.assign(e, { untertitelLage: lagen[(lagen.indexOf(e.untertitelLage) + 1) % lagen.length] });
      auftraege.aendern(a.id, { e, geaendert: true });
      return menuZeigen(a, M.untertitelMenu(a, ctx));
    }
    case "utstil":
      Object.assign(e, { untertitelStil: e.untertitelStil === "box" ? "rand" : "box" });
      auftraege.aendern(a.id, { e, geaendert: true });
      return menuZeigen(a, M.untertitelMenu(a, ctx));
    case "srt":
      return p.dokument(a.chat, werkstatt.srtFuerAusgabe(a), { text: "Korrigiert zurückschicken – oder Korrekturen als <code>falsch => richtig</code>." });
    case "korrektur":
      return warte("korrektur", "✏️ Schick mir Korrekturen, eine pro Zeile: <code>falsch => richtig</code> – oder eine <code>.srt</code>-Datei.");

    case "ton":
      return menuZeigen(a, M.tonMenu(a));
    case "ta":
    case "tr":
    case "tm":
    case "td":
    case "tx": {
      const ton = { angleichen: true, rauschen: false, musik: null, ...(e.ton ?? {}) };
      if (aktion === "ta") ton.angleichen = ton.angleichen === false;
      if (aktion === "tr") ton.rauschen = !ton.rauschen;
      if (aktion === "tx") ton.musik = null;
      if (aktion === "td" && ton.musik) ton.musik = { ...ton.musik, ducking: ton.musik.ducking === false };
      if (aktion === "tm" && ton.musik) {
        const stufen = M.MUSIK_STUFEN.map(([, l]) => l);
        const jetzt = stufen.findIndex((l) => l >= (ton.musik.lautstaerke ?? 0.25) - 0.001);
        ton.musik = { ...ton.musik, lautstaerke: stufen[(jetzt + 1) % stufen.length] };
      }
      Object.assign(e, { ton });
      auftraege.aendern(a.id, { e, geaendert: true });
      return menuZeigen(a, M.tonMenu(a));
    }
    case "tmusik":
      return warte("musik", "🎵 Schick mir die Musik als Audiodatei (MP3, M4A, OGG, WAV …). Nur Musik verwenden, die ihr nutzen dürft!", [[{ text: "⬅️ Zurück", daten: `${a.id}:ton` }]]);

    case "bauchbinde":
      return menuZeigen(a, M.bauchbindeMenu(a, ctx));
    case "bb":
      if (wert === "standard") return aendern({ bauchbinde: ctx.standardBauchbinde, bauchbindeAn: true });
      if (wert === "aus") return aendern({ bauchbindeAn: false });
      return warte("bauchbinde", "🪪 Name und Funktion schicken, z. B. <code>Anja Muster | Kreisvorsitzende</code> (oder in zwei Zeilen).");

    case "titelkarte":
      return menuZeigen(a, M.karteMenu(a, ctx, "titelkarte"));
    case "tk":
      if (wert === "aus") return aendern({ titelkarte: null });
      if (wert === "bild") return warte("titelkarte-bild", "🖼️ Schick mir das Bild für die Titelkarte (z. B. ein Sharepic aus ppicng).");
      return warte("titelkarte", "🎬 Text für die Titelkarte schicken. Erste Zeile = Claim, weitere Zeilen = Erklärtext.");
    case "abspann":
      return menuZeigen(a, M.karteMenu(a, ctx, "abspann"));
    case "ab":
      if (wert === "aus") return aendern({ abspannAn: false });
      if (wert === "standard") return aendern({ abspannAn: true, abspann: null });
      if (wert === "bild") return warte("abspann-bild", "🖼️ Schick mir das Bild für den Abspann (z. B. ein Sharepic aus ppicng).");
      return warte("abspann", "🏁 Text für den Abspann schicken, z. B. <code>Mehr auf piraten-nuernberg.de</code>.");

    case "claim":
      return warte("claim", `💬 Neuer Claim? Aktuell:\n<code>${html(e.claim)}</code>`);
    case "erklaertext": {
      const knoepfe = [[{ text: "⬅️ Zurück", daten: `${a.id}:gestaltung` }]];
      if (e.text) knoepfe.unshift([{ text: "🚫 Ohne Erklärtext", daten: `${a.id}:ohnetext` }]);
      return warte("erklaertext", `📄 Erklärtext schicken (kleiner Text unter dem Claim).${e.text ? `\nAktuell:\n<code>${html(e.text)}</code>` : ""}`, knoepfe);
    }
    case "ohnetext":
      return aendern({ text: "" });
    case "bildstil":
      return menuZeigen(a, M.bildstilMenu(a));
    case "bs":
      return aendern({ bildStil: wert });

    case "caption":
      return warte("caption", `✏️ Schick mir den neuen Text. Bisher:\n<code>${html(a.caption)}</code>`, [[{ text: "⬅️ Zurück", daten: `${a.id}:menu` }]]);
    case "ki":
      return warte("ki", "🔄 Was soll anders werden? Z. B. <code>kürzer</code>, <code>lockerer</code>, <code>mehr Fakten</code>.", [[{ text: "⬅️ Zurück", daten: `${a.id}:menu` }]]);

    case "datei":
      return dateiSchicken(a);
    case "verwerfen":
      auftraege.aendern(a.id, { status: "verworfen" });
      return menuZeigen(a, { text: "🗑️ Verworfen.", knoepfe: [] });

    case "kanaele":
      return menuZeigen(a, M.kanaeleMenu(a, ctx));
    case "k": {
      const ids = a.kanaele.includes(wertRest) ? a.kanaele.filter((x) => x !== wertRest) : [...a.kanaele, wertRest];
      auftraege.aendern(a.id, { kanaele: ids });
      return menuZeigen(a, M.kanaeleMenu(a, ctx));
    }
    case "kunde":
      return menuZeigen(a, M.kundeMenu(a, ctx));
    case "ku":
      auftraege.aendern(a.id, { kunde: wertRest === "alle" ? null : wertRest });
      auftraege.aendern(a.id, { kanaele: await standardKanaele(a) });
      return hauptmenu(a);
    case "kuerzen": {
      const kanaele = (await alleKanaele()).filter((c) => a.kanaele.includes(c.id));
      const eigene = postiz.eigeneEinstellungen();
      const captions = { ...(a.captions ?? {}) };
      for (const c of kanaele) {
        const max = zeichenLimit(c, eigene);
        if (max && zeichenZahl(captions[c.id] ?? a.caption, c.identifier) > max) {
          captions[c.id] = kuerzen(a.caption, max, (t) => zeichenZahl(t, c.identifier));
        }
      }
      auftraege.aendern(a.id, { captions });
      return menuZeigen(a, {
        text: `✂️ Gekürzt für ${Object.keys(captions).length} Kanal/Kanäle. Jetzt posten?`,
        knoepfe: [[{ text: "✅ Jetzt posten", daten: `${a.id}:jetzt` }, { text: "🕐 Planen", daten: `${a.id}:planen` }], [{ text: "⬅️ Zurück", daten: `${a.id}:menu` }]],
      });
    }

    case "jetzt":
      return menuZeigen(a, M.bestaetigenMenu(a, ctx, null));
    case "planen":
      auftraege.aendern(a.id, { wartetAuf: "zeit" });
      return menuZeigen(a, M.planenMenu(a));
    case "z":
      return menuZeigen(a, M.bestaetigenMenu(a, ctx, new Date(Number(wert))));
    case "slot": {
      const erster = a.kanaele[0];
      if (!erster) return p.senden(a.chat, "Keine Kanäle gewählt.");
      return menuZeigen(a, M.bestaetigenMenu(a, ctx, await postiz.freierSlot(erster)));
    }
    case "ja":
      return posten(a, wert === "jetzt" ? null : new Date(Number(wert)));
    default:
      return p.senden(a.chat, "Unbekannter Knopf.");
  }
}

async function dateiSchicken(a) {
  const p = von(a);
  if (!a.ergebnis || !fs.existsSync(a.ergebnis)) return p.senden(a.chat, "Die Datei gibt es nicht mehr (nach 14 Tagen wird aufgeräumt).");
  const groesse = fs.statSync(a.ergebnis).size;
  if (groesse > p.maxUpload) {
    const ort = config.ausgabeOrdner ? ` Sie liegt im Ausgabeordner (${html(config.ausgabeOrdner)}).` : " Tipp: AUSGABE_ORDNER setzen, dann landen fertige Dateien zusätzlich dort.";
    return p.senden(a.chat, `📦 Die Datei ist ${Math.round(groesse / 1048576)} MB groß – zu groß zum Verschicken hier.${ort}`);
  }
  const endung = path.extname(a.ergebnis);
  const name = path.join(a.ordner, `piraten-${a.art}-${a.id}${endung}`);
  await fsp.copyFile(a.ergebnis, name);
  await p.dokument(a.chat, name, { text: "📥 In voller Qualität" });
}

// ---------- Texteingaben ----------

async function eingabe(a, ereignis) {
  const p = von(a);
  const text = ereignis.text ?? "";
  const ctx = await kontext(a);
  const e = a.e;
  const gestaltet = async (felder) => {
    Object.assign(e, felder);
    auftraege.aendern(a.id, { e, geaendert: true, wartetAuf: null });
    await menuZeigen(a, M.gestaltungMenu(a, ctx), { neu: true });
  };

  // Bilder und Dateien
  if (ereignis.typ === "medium") {
    const m = ereignis.medium;
    if (["titelkarte-bild", "abspann-bild"].includes(a.wartetAuf) && m.art === "foto") {
      const bild = await fotoEmpfangen(ereignis, { a, zweck: a.wartetAuf });
      return gestaltet(a.wartetAuf === "titelkarte-bild" ? { titelkarte: { bild } } : { abspannAn: true, abspann: { bild } });
    }
    if (a.wartetAuf === "musik" && m.art === "ton") {
      const datei = path.join(a.ordner, `musik-${Date.now()}${sichereEndung(m.name, "ton")}`);
      await p.herunterladen(m, datei);
      try {
        await werkstatt.musikSetzen(a, datei, m.name);
      } catch (err) {
        await fsp.rm(datei, { force: true });
        return p.senden(a.chat, `Die Musik ließ sich nicht lesen: ${html(err.message.split("\n")[0])}`);
      }
      auftraege.aendern(a.id, { wartetAuf: null, geaendert: true });
      return menuZeigen(a, M.tonMenu(a), { neu: true });
    }
    if (a.wartetAuf === "korrektur" && /\.srt$/i.test(m.name)) {
      const ziel = path.join(a.ordner, "neu.srt");
      await p.herunterladen(m, ziel);
      const anzahl = werkstatt.srtUebernehmen(a, await fsp.readFile(ziel, "utf8"));
      if (!anzahl) return p.senden(a.chat, "In der Datei habe ich keine Untertitel gefunden.");
      return gestaltet({ untertitel: true });
    }
    return false; // kein passendes Medium – als neuen Beitrag behandeln
  }

  switch (a.wartetAuf) {
    case "caption":
      auftraege.aendern(a.id, { caption: text, captions: {}, wartetAuf: null, captionHinweis: "" });
      return hauptmenu(a, { neu: true });
    case "ki":
      auftraege.aendern(a.id, { wartetAuf: null });
      await p.senden(a.chat, "🔄 Formuliere neu …");
      await werkstatt.captionErzeugen(a, text);
      return hauptmenu(a, { neu: true });
    case "logo": {
      const treffer = sucheLogos(ppicng, text);
      if (treffer.length === 1) return gestaltet({ logo: treffer[0].id });
      return menuZeigen(a, M.logoMenu(a, ctx, treffer, text), { neu: true });
    }
    case "bauchbinde": {
      const bb = parseBauchbinde(text);
      if (!bb) return p.senden(a.chat, "Bitte als <code>Name | Funktion</code> schicken.");
      return gestaltet({ bauchbinde: bb, bauchbindeAn: true });
    }
    case "titelkarte": {
      const [claim, ...rest] = text.split("\n");
      return gestaltet({ titelkarte: { claim: claim.trim(), text: rest.join("\n").trim() } });
    }
    case "abspann":
      return gestaltet({ abspannAn: true, abspann: { claim: text.trim() } });
    case "claim":
      return gestaltet({ claim: text.trim() });
    case "erklaertext":
      return gestaltet({ text: text.trim() });
    case "korrektur": {
      const korrekturen = parseKorrekturen(text);
      if (!korrekturen.length) return p.senden(a.chat, "Bitte als <code>falsch => richtig</code> schicken, eine pro Zeile.");
      werkstatt.korrigieren(a, korrekturen);
      await p.senden(a.chat, `✏️ ${korrekturen.length} Korrektur(en) übernommen.`);
      return gestaltet({ untertitel: true });
    }
    case "zeit": {
      const zeit = parseZeit(text);
      if (!zeit) return p.senden(a.chat, "Die Zeit habe ich nicht verstanden – z. B. <code>morgen 18 Uhr</code>.");
      auftraege.aendern(a.id, { wartetAuf: null });
      return menuZeigen(a, M.bestaetigenMenu(a, ctx, zeit), { neu: true });
    }
  }
  return false;
}

// ---------- Befehle ----------

async function befehl(ereignis, name, rest) {
  const p = plattformen[ereignis.plattform];
  const ctx = { plattform: ereignis.plattform, postiz: Boolean(postiz), ppicngUrl: config.ppicng.url, webUrl: config.web?.url };
  switch (name) {
    case "start":
    case "hilfe":
    case "help":
      return p.senden(ereignis.chat, M.hilfe(ctx));
    case "id":
      return p.senden(ereignis.chat, `Deine ID: <code>${html(ereignis.nutzer)}</code>\nDieser Chat: <code>${html(ereignis.chat)}</code>`);
    case "status":
      return p.senden(ereignis.chat, await statusText());
    case "abbrechen": {
      const a = auftraege.wartend(chatKey(ereignis.plattform, ereignis.chat));
      if (a) auftraege.aendern(a.id, { wartetAuf: null });
      return p.senden(ereignis.chat, "OK, abgebrochen.");
    }
    case "logo": {
      if (!rest) return p.senden(ereignis.chat, `Suchbegriff fehlt, z. B. <code>${ereignis.plattform === "matrix" ? "!" : "/"}logo Bayern</code>`);
      const treffer = sucheLogos(ppicng, rest, 15);
      return p.senden(ereignis.chat, treffer.length
        ? `<b>Logos aus ppicng</b> (ID für LOGO in .env oder chats.json):\n${treffer.map((l) => `• ${html(l.titel)} (${html(l.gruppeTitel)}) – <code>${html(l.id)}</code>`).join("\n")}`
        : "Kein Logo gefunden.");
    }
    case "sharepic":
      if (!rest) return p.senden(ereignis.chat, "Claim fehlt, z. B. <code>/sharepic Freies WLAN für alle!</code> – Erklärtext in die zweite Zeile.");
      return sharepicEmpfangen(ereignis, rest);
    case "kanaele": {
      if (!postiz) return p.senden(ereignis.chat, "Postiz ist nicht angebunden.");
      const alle = await alleKanaele();
      const zeilen = alle.map((c) => `• ${html(c.name)} (${c.identifier})${c.customer ? ` – 👤 ${html(c.customer.name)}` : ""} <code>${c.id}</code>`);
      return p.senden(ereignis.chat, `<b>Postiz-Kanäle</b>\n${zeilen.join("\n") || "keine"}`);
    }
    default:
      return p.senden(ereignis.chat, `Den Befehl kenne ich nicht. ${ereignis.plattform === "matrix" ? "!" : "/"}start zeigt die Hilfe.`);
  }
}

async function statusText() {
  const zeilen = ["<b>Status</b>"];
  const pruef = async (name, fn) => {
    try {
      zeilen.push(`✅ ${name}: ${await fn()}`);
    } catch (e) {
      zeilen.push(`❌ ${name}: ${html(e.message.split("\n")[0])}`);
    }
  };
  await pruef("ffmpeg", async () => (await ausfuehren("ffmpeg", ["-version"])).split("\n")[0].replace("ffmpeg version ", ""));
  await pruef("ppicng", async () => {
    const stand = await ausfuehren("git", ["-C", ppicng.dir, "log", "-1", "--format=%h vom %cs"]).catch(() => "");
    return `${ppicng.logos.length} Logos${stand ? `, Stand ${stand.trim()}` : ""}`;
  });
  if (config.whisper) await pruef("Whisper", async () => {
    await fsp.access(config.whisper.modell);
    return path.basename(config.whisper.modell);
  });
  else zeilen.push("➖ Whisper: nicht eingerichtet (keine automatischen Untertitel)");
  if (postiz) await pruef("Postiz", async () => `${(await postiz.kanaele()).length} Kanäle, ${zaehler.anzahl()} Anfragen in der letzten Stunde`);
  else zeilen.push("➖ Postiz: nicht angebunden (nur Datei-Download)");
  zeilen.push(config.caption.anbieter ? `✅ KI: ${config.caption.anbieter} (${config.caption.modell})` : "➖ KI: aus (einfache Textvorschläge)");
  zeilen.push(werkstatt.gesichtAktiv ? "✅ Gesichtssuche: OpenCV" : "➖ Gesichtssuche: aus (Python mit OpenCV fehlt, GESICHT_PYTHON)");
  if (config.web) zeilen.push(`✅ Web-Version: ${html(config.web.url ?? `Port ${config.web.port}`)}`);
  zeilen.push(`ℹ️ Plattformen: ${Object.keys(plattformen).join(", ") || "keine"} · Warteschlange: ${werkstatt.wartend}`);
  return zeilen.join("\n");
}

// ---------- Eingang aller Ereignisse ----------

async function verarbeiten(ereignis) {
  const p = plattformen[ereignis.plattform];
  try {
    const textBefehl = ereignis.typ === "knopf" ? null : (ereignis.text ?? "").match(/^[/!]([a-zäöü]+)(?:@\S+)?\s*([\s\S]*)$/i);
    if (textBefehl?.[1].toLowerCase() === "id") return befehl(ereignis, "id", "");
    if (!p.erlaubt(ereignis)) {
      // In Gruppen und Räumen schweigen, im Einzelchat erklären
      if (!ereignis.gruppe && ereignis.typ !== "knopf") {
        await p.senden(ereignis.chat, `Du bist (noch) nicht freigeschaltet. Deine ID: <code>${html(ereignis.nutzer)}</code> – die muss in ${ereignis.plattform === "matrix" ? "MATRIX_ERLAUBT" : "TELEGRAM_ERLAUBT"} stehen.`);
      }
      return;
    }
    if (ereignis.typ === "knopf") return await knopf(ereignis);
    if (textBefehl && ereignis.typ === "text") return await befehl(ereignis, textBefehl[1].toLowerCase(), textBefehl[2].trim());
    if (/^abbrechen$/i.test(ereignis.text ?? "")) return await befehl(ereignis, "abbrechen", "");

    const offen = auftraege.wartend(chatKey(ereignis.plattform, ereignis.chat));
    // Matrix: Zahl als Antwort auf das letzte Menü – auch während Logosuche und Planen,
    // nicht aber, wenn gerade ein freier Text erwartet wird
    const zahlWaehlt = ereignis.auswahl && (!offen || ["logo", "zeit"].includes(offen.wartetAuf));
    if (zahlWaehlt) return await knopf({ ...ereignis, typ: "knopf", daten: ereignis.auswahl, nachricht: undefined });
    if (offen && (await eingabe(offen, ereignis)) !== false) return;

    if (ereignis.typ === "medium") {
      if (ereignis.medium.art === "video") return await videoEmpfangen(ereignis);
      if (ereignis.medium.art === "foto") return await fotoEmpfangen(ereignis);
      if (ereignis.medium.art === "ton") return await p.senden(ereignis.chat, "🎵 Musik? Erst das Video schicken, dann unter 🎨 Gestaltung → 🔊 Ton „Musik schicken“.");
      return await p.senden(ereignis.chat, "Mit dieser Datei kann ich nichts anfangen – schick ein Video oder ein Foto.");
    }
    // Freier Text im Einzelchat wird ein Sharepic; in Gruppen und Räumen nur mit /sharepic bzw. !sharepic
    if (!ereignis.gruppe) return await sharepicEmpfangen(ereignis, ereignis.text);
  } catch (e) {
    console.error(e);
    await p.senden(ereignis.chat, `❌ ${html(e.message).slice(0, 1500)}`).catch(() => {});
  }
}

// ---------- Kontrolle nach dem Posten ----------

const kontrollDatei = path.join(config.datenDir, "kontrolle.json");
async function kontrollieren() {
  if (!postiz) return;
  let kontrolle = {};
  try {
    kontrolle = JSON.parse(fs.readFileSync(kontrollDatei, "utf8"));
  } catch {}
  const erwartet = erwartetePosts(Object.values(auftraege.alle));
  const faellig = faelligeKontrollen(erwartet, kontrolle);
  if (!faellig.length) return;
  const { von: ab, bis } = abfragezeitraum(faellig);
  const meldungen = auswerten(await postiz.posts(ab, bis), faellig, kontrolle);
  fs.writeFileSync(kontrollDatei, JSON.stringify(kontrolle));
  for (const [chatId, texte] of meldungen) {
    const [plattform, ...chat] = String(chatId).split("|");
    for (const t of texte) await plattformen[plattform]?.senden(chat.join("|"), html(t)).catch(() => {});
  }
}

// ---------- Start ----------

for (const [name, p] of Object.entries(plattformen)) {
  const wer = await p.verbinden();
  console.log(`${name}: verbunden als ${wer}`);
  p.lauschen(verarbeiten);
}
if (config.web) {
  const adresse = await starteWeb({ config, werkstatt });
  console.log(`web: ${adresse}`);
}
console.log(`ppicng: ${ppicng.logos.length} Logos · Postiz: ${postiz ? "an" : "aus"} · Whisper: ${config.whisper ? "an" : "aus"} · Gesicht: ${werkstatt.gesichtAktiv ? "an" : "aus"} · KI: ${config.caption.anbieter ?? "aus"}`);

// Aufträge, die beim letzten Beenden mitten in der Arbeit waren, als Fehler markieren
for (const a of Object.values(auftraege.alle)) if (a.status === "arbeitet") auftraege.aendern(a.id, { status: "fehler" });
auftraege.aufraeumen();
setInterval(() => auftraege.aufraeumen(), 24 * 3600e3);
setInterval(() => kontrollieren().catch((e) => console.error("Kontrolle:", e.message)), 5 * 60e3);
