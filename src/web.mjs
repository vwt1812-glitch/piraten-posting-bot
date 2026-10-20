// Web-Version: dieselbe Werkstatt wie der Bot, bedienbar im Browser – wie ppicng, aber auch für Videos.
// Kein Framework, nur node:http. Die Seite selbst liegt in web/ (HTML, CSS, JS ohne Build-Schritt).
//
// Zwei Modi:
//   • offen (kein Postiz, keine Anmeldung eingestellt): Jeder Browser bekommt eine Gast-Sitzung und sieht nur
//     seine eigenen Projekte. Grenzen gegen Missbrauch: Uploads je Adresse und Stunde, Länge, Speicher,
//     offene Projekte, gleichzeitige Aufträge.
//   • Anmeldung (Pflicht, sobald Postiz eingerichtet ist): Team-Passwort (WEB_PASSWORT) und/oder das eigene
//     Matrix-Konto (WEB_MATRIX_ANMELDUNG, erlaubt sind die Konten aus WEB_ERLAUBT). Das Matrix-Passwort geht
//     nur einmal zum Matrix-Server; der dabei entstandene Zugang wird sofort wieder abgemeldet.
// Sitzungen liegen auf dem Server (websicherheit.mjs), Cookies sind HttpOnly, SameSite=Strict und – mit
// https-WEB_URL – Secure mit __Host-Präfix. Schreibende Anfragen brauchen den Kopf X-PPB und, wenn der Browser
// einen Origin mitschickt, denselben Host.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { FARBSCHEMATA, logoNachId, logoDatei } from "./ppicng.mjs";
import { FORMATE, fotoNormalisieren, sichereEndung, tonUntersuchen } from "./video.mjs";
import { formatSrt } from "./untertitel.mjs";
import { schnittPruefen, cuesPruefen, schnittDauer, UEBERGAENGE } from "./schnitt.mjs";
import { kuerzen } from "./caption.mjs";
import { kundenAus, zeichenLimit, zeichenZahl } from "./postiz.mjs";
import { istErlaubt } from "./plattform/matrix.mjs";
import { SHAREPIC_FORMATE, BILDSTILE, LAGEN } from "./menues.mjs";
import { zeitText } from "./zeit.mjs";
import { Sitzungen, Begrenzer, clientAdresse, ordnerGroesse, groesseVergessen, protokollierer, passwortMerkmal } from "./websicherheit.mjs";
import { untersuche } from "./video.mjs";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MB = 1024 * 1024;
const SITZUNG_TAGE = 14;

const STATISCH = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/stil.css": ["stil.css", "text/css; charset=utf-8"],
};
const TYPEN = {
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".otf": "font/otf", ".srt": "application/x-subrip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".mka": "audio/x-matroska",
};
const VIDEO_ENDUNG = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/i;

export class HttpFehler extends Error {
  constructor(status, text, daten) {
    super(text);
    this.status = status;
    this.daten = daten;
  }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => {
  const i = c.indexOf("=");
  return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
}));

function gleich(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Anmeldung mit Matrix-Konto: ein Login beim Server, Zugang sofort wieder abmelden. */
export async function matrixPruefen(url, nutzer, passwort) {
  const res = await fetch(`${url}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: nutzer }, password: passwort, initial_device_display_name: "Piraten-Posting-Bot (Web-Anmeldung)" }),
  });
  if (res.status === 403 || res.status === 401) return null;
  if (!res.ok) throw new HttpFehler(502, `Matrix-Server antwortet nicht wie erwartet (${res.status}).`);
  const { user_id, access_token } = await res.json();
  fetch(`${url}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${access_token}` } }).catch(() => {});
  return user_id;
}

// ---------- Einstellungen aus dem Browser prüfen ----------

const aus = (wert, erlaubt, alt) => (erlaubt.includes(wert) ? wert : alt);
const textFeld = (wert, max, alt = "") => (typeof wert === "string" ? wert.slice(0, max) : alt);
const jaNein = (wert, alt) => (typeof wert === "boolean" ? wert : alt);

/**
 * Nur bekannte Felder mit gültigen Werten übernehmen. Dateipfade (Foto, Bilder für Titelkarte und Abspann)
 * kommen nie aus dem Browser, sondern bleiben, wie sie auf dem Server gespeichert sind.
 */
export function bereinigen(neu, alt, ppicng) {
  const e = { ...alt };
  if (!neu || typeof neu !== "object") return e;
  e.design = aus(neu.design, Object.keys(FARBSCHEMATA), alt.design);
  if (typeof neu.logo === "string" && (neu.logo === "kein" || logoNachId(ppicng, neu.logo))) e.logo = neu.logo;
  e.logoStil = aus(neu.logoStil, ["plakette", "frei"], alt.logoStil);
  e.logoPosition = aus(neu.logoPosition, ["oben-links", "oben-rechts", "unten-links", "unten-rechts"], alt.logoPosition);
  e.format = aus(neu.format, Object.keys(FORMATE), alt.format);
  e.sharepicFormat = aus(neu.sharepicFormat, SHAREPIC_FORMATE, alt.sharepicFormat);
  e.anpassen = aus(neu.anpassen, ["rand", "zuschneiden"], alt.anpassen);
  e.untertitel = jaNein(neu.untertitel, alt.untertitel);
  e.untertitelStil = aus(neu.untertitelStil, ["box", "rand"], alt.untertitelStil);
  e.untertitelLage = aus(neu.untertitelLage, Object.keys(LAGEN), alt.untertitelLage);
  e.bildStil = aus(neu.bildStil, Object.keys(BILDSTILE), alt.bildStil);
  e.claim = textFeld(neu.claim, 300, alt.claim);
  e.text = textFeld(neu.text, 800, alt.text);
  e.bauchbindeAn = jaNein(neu.bauchbindeAn, alt.bauchbindeAn);
  if (neu.bauchbinde && typeof neu.bauchbinde === "object") {
    e.bauchbinde = { name: textFeld(neu.bauchbinde.name, 60), funktion: textFeld(neu.bauchbinde.funktion, 80) };
  }
  e.abspannAn = jaNein(neu.abspannAn, alt.abspannAn);
  const karte = (k, bisher) => {
    if (k === null) return null;
    if (!k || typeof k !== "object") return bisher;
    if (k.art === "bild") return bisher?.bild ? { bild: bisher.bild } : null;
    return { claim: textFeld(k.claim, 300), text: textFeld(k.text, 800) };
  };
  if (neu.ton && typeof neu.ton === "object") {
    const altTon = alt.ton ?? {};
    const zahl = (wert, min, max, standard) => (Number.isFinite(Number(wert)) ? Math.max(min, Math.min(max, Number(wert))) : standard);
    e.ton = { angleichen: jaNein(neu.ton.angleichen, altTon.angleichen ?? true), rauschen: jaNein(neu.ton.rauschen, altTon.rauschen ?? false), musik: altTon.musik ?? null };
    // Musikdatei bleibt die vom Server; aus dem Browser nur Lautstärke, Ducking, Startpunkt – oder entfernen
    if (neu.ton.musik === null) e.ton.musik = null;
    else if (e.ton.musik && neu.ton.musik && typeof neu.ton.musik === "object") {
      e.ton.musik = {
        ...e.ton.musik,
        lautstaerke: zahl(neu.ton.musik.lautstaerke, 0, 1, e.ton.musik.lautstaerke),
        ducking: jaNein(neu.ton.musik.ducking, e.ton.musik.ducking),
        ab: zahl(neu.ton.musik.ab, 0, Math.max(0, (e.ton.musik.dauer ?? 1) - 1), e.ton.musik.ab),
      };
    }
  }
  if ("titelkarte" in neu) e.titelkarte = karte(neu.titelkarte, alt.titelkarte);
  if ("abspann" in neu) e.abspann = karte(neu.abspann, alt.abspann);
  return e;
}

/** Was der Browser über einen Auftrag erfährt (ohne Dateipfade). */
export function ansicht(a, werkstatt) {
  const karte = (k) => (k ? (k.bild ? { art: "bild" } : { art: "text", claim: k.claim ?? "", text: k.text ?? "" }) : null);
  const clips = werkstatt.clips(a);
  const schnitt = werkstatt.schnitt(a);
  const erster = werkstatt.ersterClip(a);
  const gefunden = clips.filter((c) => c.gesichter !== undefined);
  return {
    id: a.id,
    art: a.art,
    status: a.status,
    schritt: a.schritt ?? "",
    fehler: a.fehler ?? "",
    warnungen: a.warnungen ?? [],
    erstellt: a.erstellt,
    e: {
      ...a.e, bild: Boolean(a.e.bild), titelkarte: karte(a.e.titelkarte), abspann: karte(a.e.abspann),
      ton: { angleichen: true, rauschen: false, ...(a.e.ton ?? {}), musik: a.e.ton?.musik ? { ...a.e.ton.musik, datei: undefined } : null },
    },
    quelle: erster ? { breite: erster.breite, hoehe: erster.hoehe, dauer: schnittDauer(schnitt), hatTon: clips.some((c) => c.hatTon) } : null,
    clips: clips.map((c) => ({
      id: c.id, name: c.name, breite: c.breite, hoehe: c.hoehe, dauer: c.dauer, hatTon: c.hatTon,
      bereit: Boolean(c.arbeitskopie), bilder: c.arbeitskopie?.bilder ?? 0, welle: Boolean(c.arbeitskopie?.welle),
    })),
    schnitt,
    untertitel: a.art === "video" ? werkstatt.cues(a) : [],
    srt: a.art === "video" ? formatSrt(werkstatt.ausgabeCues(a)) : "",
    caption: a.caption ?? "",
    captionHinweis: a.captionHinweis ?? "",
    kanaele: a.kanaele ?? [],
    lage: a.lage ?? null,
    lageAutomatisch: Boolean(a.lageAutomatisch),
    gesichtHinweise: a.gesichtHinweise ?? [],
    gesichter: gefunden.length ? gefunden.reduce((n, c) => n + (c.gesichter?.gesichter?.length ?? 0), 0) : null,
    ergebnis: a.ergebnis && fs.existsSync(a.ergebnis) ? { version: fs.statSync(a.ergebnis).mtimeMs, masse: a.masse } : null,
    plan: a.plan ?? null,
    geaendert: Boolean(a.geaendert),
  };
}

// ---------- Server ----------

/**
 * @returns {Promise<string>} Adresse, unter der die Web-Version läuft
 */
export async function starteWeb({ config, werkstatt }) {
  const w = config.web;
  const { ppicng, auftraege } = werkstatt;
  fs.mkdirSync(config.datenDir, { recursive: true });
  const geheimnisDatei = path.join(config.datenDir, "web-geheimnis");
  if (!fs.existsSync(geheimnisDatei)) fs.writeFileSync(geheimnisDatei, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const geheimnis = fs.readFileSync(geheimnisDatei, "utf8").trim();
  const sitzungen = new Sitzungen(path.join(config.datenDir, "web-sitzungen.json"));
  setInterval(() => sitzungen.aufraeumen(), 3600e3).unref();
  const protokoll = protokollierer(path.join(config.datenDir, "web-protokoll.log"));
  const grenzen = {
    anmeldungAdresse: new Begrenzer(10, 15 * 60e3), // Fehlversuche je Adresse
    anmeldungName: new Begrenzer(20, 3600e3), // Fehlversuche je Name (gegen verteiltes Raten)
    gaeste: new Begrenzer(30, 3600e3), // neue Gast-Sitzungen je Adresse
    uploads: new Begrenzer(w.uploadsProStunde, 3600e3),
  };
  // Mit https-Adresse: Cookie nur über https und fest an diesen Host gebunden
  const sicher = w.url.startsWith("https://");
  const COOKIE = sicher ? "__Host-ppb" : "ppb";
  const cookieSetzen = (wert, tage) => `${COOKIE}=${wert}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(tage * 86400)}${sicher ? "; Secure" : ""}`;
  if (!w.anmeldung) console.log("web: offen ohne Anmeldung (kein Postiz) – Projekte gehören dem jeweiligen Browser");

  /** Sitzung aus dem Cookie – nur, solange sie zur aktuellen Einstellung passt. */
  function nutzerAus(req) {
    const s = sitzungen.lesen(cookies(req)[COOKIE]);
    if (!s) return null;
    if (s.art === "passwort") return w.passwort && s.merkmal === passwortMerkmal(geheimnis, w.passwort) ? s.nutzer : null;
    if (s.art === "matrix") return w.matrixAnmeldung && istErlaubt(w.erlaubt, s.nutzer, "") ? s.nutzer : null;
    if (s.art === "gast") return w.anmeldung ? null : s.nutzer;
    return null;
  }

  const darfPosten = (nutzer) => Boolean(werkstatt.postiz) && w.anmeldung && !String(nutzer).startsWith("gast:") &&
    (w.posten === true || (Array.isArray(w.posten) && istErlaubt(w.posten, nutzer, "")));

  const offen = (nutzer) => Object.values(auftraege.alle).filter((a) => a.plattform === "web" && a.chat === nutzer);

  /** Grenzen vor jedem Upload und neuen Projekt. */
  function grenzenPruefen(nutzer, ip, { neuesProjekt = false, upload = false } = {}) {
    if (upload && !grenzen.uploads.erlauben(ip)) throw new HttpFehler(429, "Zu viele Uploads in der letzten Stunde – bitte später nochmal.");
    if ((upload || neuesProjekt) && ordnerGroesse(config.datenDir) > w.maxSpeicherGb * 1024 ** 3) {
      throw new HttpFehler(507, "Der Speicher des Bots ist voll – alte Projekte verwerfen oder später nochmal (nach 14 Tagen wird aufgeräumt).");
    }
    const meine = offen(nutzer);
    if (neuesProjekt && meine.filter((a) => ["entwurf", "bereit", "arbeitet", "fehler"].includes(a.status)).length >= w.offeneProjekte) {
      throw new HttpFehler(429, `Du hast schon ${w.offeneProjekte} offene Projekte – erst alte verwerfen (Meine Beiträge).`);
    }
    if (upload && meine.filter((a) => a.status === "arbeitet").length >= 2) {
      throw new HttpFehler(429, "Bei dir laufen schon zwei Aufträge – bitte warten, bis einer fertig ist.");
    }
  }

  /** Video nicht länger als erlaubt (gegen Missbrauch der Rechenzeit). */
  async function laengePruefen(datei) {
    const info = await untersuche(datei).catch((e) => {
      throw new HttpFehler(400, `Das Video ließ sich nicht lesen: ${e.message.split("\n")[0]}`);
    });
    if (info.dauer > w.maxMinuten * 60) throw new HttpFehler(413, `Das Video ist länger als ${w.maxMinuten} Minuten.`);
  }

  function eigenerAuftrag(nutzer, id) {
    const a = auftraege.get(id);
    if (!a || a.plattform !== "web" || a.chat !== nutzer) throw new HttpFehler(404, "Diesen Beitrag gibt es nicht (mehr).");
    return a;
  }

  async function jsonLesen(req, max = MB) {
    let laenge = 0;
    const teile = [];
    for await (const t of req) {
      laenge += t.length;
      if (laenge > max) throw new HttpFehler(413, "Zu groß.");
      teile.push(t);
    }
    if (!laenge) return {};
    try {
      return JSON.parse(Buffer.concat(teile));
    } catch {
      throw new HttpFehler(400, "Ungültiges JSON.");
    }
  }

  /** Hochgeladene Datei (roher Body) speichern, mit Größengrenze. */
  async function dateiLesen(req, ziel) {
    const angegeben = Number(req.headers["content-length"] ?? 0);
    if (angegeben > w.maxMb * MB) throw new HttpFehler(413, `Die Datei ist zu groß (höchstens ${w.maxMb} MB).`);
    let laenge = 0;
    req.on("data", (t) => {
      laenge += t.length;
      if (laenge > w.maxMb * MB) req.destroy(new HttpFehler(413, `Die Datei ist zu groß (höchstens ${w.maxMb} MB).`));
    });
    await pipeline(req, fs.createWriteStream(ziel));
    if (!laenge) throw new HttpFehler(400, "Leere Datei.");
  }

  function senden(res, status, daten, kopf = {}) {
    const body = Buffer.isBuffer(daten) ? daten : Buffer.from(JSON.stringify(daten));
    res.writeHead(status, { "Content-Type": Buffer.isBuffer(daten) ? "application/octet-stream" : "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", ...kopf });
    res.end(body);
  }

  /** Datei ausliefern, mit Range-Anfragen (zum Spulen im Video). */
  function dateiSenden(req, res, datei, { name, herunterladen = false } = {}) {
    if (!datei || !fs.existsSync(datei)) throw new HttpFehler(404, "Datei nicht gefunden.");
    const groesse = fs.statSync(datei).size;
    const kopf = {
      "Content-Type": TYPEN[path.extname(datei).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      ...(herunterladen ? { "Content-Disposition": `attachment; filename="${name ?? path.basename(datei)}"` } : {}),
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, groesse - Number(range[2]));
      const ende = range[1] && range[2] ? Math.min(Number(range[2]), groesse - 1) : groesse - 1;
      if (start >= groesse || start > ende) {
        res.writeHead(416, { "Content-Range": `bytes */${groesse}` });
        return res.end();
      }
      res.writeHead(206, { ...kopf, "Content-Range": `bytes ${start}-${ende}/${groesse}`, "Content-Length": ende - start + 1 });
      return fs.createReadStream(datei, { start, end: ende }).pipe(res);
    }
    res.writeHead(200, { ...kopf, "Content-Length": groesse });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(datei).pipe(res);
  }

  /** Im Hintergrund weiterarbeiten; der Browser fragt den Stand ab. */
  function hintergrund(a, fn) {
    auftraege.aendern(a.id, { status: "arbeitet", schritt: "⏳ In der Warteschlange …", fehler: "" });
    werkstatt.arbeit(async () => {
      try {
        await fn((t) => auftraege.aendern(a.id, { schritt: t }));
      } catch (e) {
        console.error(`Web-Auftrag ${a.id}:`, e);
        auftraege.aendern(a.id, { status: a.ergebnis && !a.geaendert ? "bereit" : "entwurf", schritt: "", fehler: e.message.slice(0, 1500) });
        return;
      }
      if (a.status === "arbeitet") auftraege.aendern(a.id, { status: a.ergebnis && !a.geaendert ? "bereit" : "entwurf" });
      auftraege.aendern(a.id, { schritt: "" });
    });
  }

  function optionen(nutzer) {
    return {
      nutzer,
      posten: darfPosten(nutzer),
      designs: Object.entries(FARBSCHEMATA).map(([id, s]) => ({ id, ...s })),
      formate: Object.entries(FORMATE).map(([id, f]) => ({ id, titel: f.titel })),
      sharepicFormate: SHAREPIC_FORMATE,
      bildstile: BILDSTILE,
      uebergaenge: Object.fromEntries(Object.entries(UEBERGAENGE).map(([art, u]) => [art, u.titel])),
      lagen: Object.fromEntries(Object.entries(LAGEN).filter(([l]) => l !== "auto" || werkstatt.gesichtAktiv)),
      logos: ppicng.logos.map((l) => ({ id: l.id, titel: l.titel, gruppe: l.gruppeTitel })),
      funktionen: { whisper: Boolean(config.whisper), gesicht: werkstatt.gesichtAktiv, postiz: Boolean(werkstatt.postiz), ki: Boolean(config.caption.anbieter) },
      ppicngUrl: config.ppicng.url,
      maxMb: w.maxMb,
    };
  }

  async function api(req, res, url, nutzer, ip) {
    const teile = url.pathname.split("/").filter(Boolean); // ["api", …]
    const [, bereich, id, aktion, clipId, clipAktion] = teile;
    const m = req.method;

    if (bereich === "optionen" && m === "GET") return senden(res, 200, optionen(nutzer));

    if (bereich === "logo" && m === "GET") {
      const logo = logoNachId(ppicng, `${id}/${aktion}`);
      if (!logo) throw new HttpFehler(404, "Logo nicht gefunden.");
      const schrift = /^[0-9a-f]{6}$/i.test(url.searchParams.get("schrift") ?? "") ? `#${url.searchParams.get("schrift")}` : "#000000";
      return dateiSenden(req, res, logoDatei(logo, schrift));
    }

    if (bereich === "auftraege" && m === "GET") {
      const meine = Object.values(auftraege.alle)
        .filter((a) => a.plattform === "web" && a.chat === nutzer && a.status !== "verworfen")
        .sort((a, b) => b.erstellt.localeCompare(a.erstellt))
        .slice(0, 20)
        .map((a) => ({ id: a.id, art: a.art, status: a.status, erstellt: a.erstellt, titel: a.art === "video" ? (a.titel ?? "Video") : a.e.claim || "Sharepic" }));
      return senden(res, 200, meine);
    }

    // Neuer Beitrag: Sharepic ohne Foto
    if (bereich === "sharepic" && m === "POST") {
      grenzenPruefen(nutzer, ip, { neuesProjekt: true });
      const daten = await jsonLesen(req);
      const a = werkstatt.neu({ plattform: "web", chat: nutzer, art: "sharepic", von: nutzer });
      auftraege.aendern(a.id, { status: "entwurf", e: bereinigen(daten.e, a.e, ppicng) });
      await werkstatt.kanaeleVorwaehlen(a);
      return senden(res, 200, ansicht(a, werkstatt));
    }

    // Neuer Beitrag: Video oder Foto hochladen
    if (bereich === "hochladen" && m === "POST") {
      grenzenPruefen(nutzer, ip, { neuesProjekt: true, upload: true });
      const name = path.basename(url.searchParams.get("name") ?? "datei");
      const istVideo = VIDEO_ENDUNG.test(name) || String(req.headers["content-type"]).startsWith("video/");
      const a = werkstatt.neu({ plattform: "web", chat: nutzer, art: istVideo ? "video" : "sharepic", von: nutzer });
      try {
        if (istVideo) {
          const original = path.join(a.ordner, `original${sichereEndung(name, "video")}`);
          await dateiLesen(req, original);
          groesseVergessen(config.datenDir);
          await laengePruefen(original);
          await werkstatt.videoAnnehmen(a, original, "", name);
          auftraege.aendern(a.id, { titel: name });
          await werkstatt.kanaeleVorwaehlen(a);
          hintergrund(a, async (schritt) => {
            const warnungen = await werkstatt.analysieren(a, schritt, { arbeitskopien: true });
            await werkstatt.captionErzeugen(a);
            auftraege.aendern(a.id, { status: "entwurf", warnungen });
          });
        } else {
          const roh = path.join(a.ordner, `eingang${sichereEndung(name, "bild")}`);
          await dateiLesen(req, roh);
          const bild = path.join(a.ordner, "foto.png");
          await fotoNormalisieren(roh, bild);
          await fsp.rm(roh, { force: true });
          a.e.bild = bild;
          a.e.bildStil = "logo";
          auftraege.aendern(a.id, { status: "entwurf", e: a.e });
          await werkstatt.kanaeleVorwaehlen(a);
        }
      } catch (e) {
        auftraege.aendern(a.id, { status: "verworfen" });
        if (e instanceof HttpFehler) throw e;
        throw new HttpFehler(400, `Die Datei ließ sich nicht lesen: ${e.message.split("\n")[0]}`);
      }
      return senden(res, 200, ansicht(a, werkstatt));
    }

    // Beitrag aus Telegram/Matrix im Browser weiterbearbeiten (Link mit Einmal-Schlüssel aus dem Bot)
    if (bereich === "uebernehmen" && m === "POST") {
      const { id: aid, schluessel } = await jsonLesen(req, 10000);
      const a = auftraege.get(String(aid ?? ""));
      if (!a || !a.freigabe || !schluessel || !gleich(schluessel, a.freigabe)) throw new HttpFehler(404, "Der Link ist ungültig oder wurde schon benutzt.");
      if (a.status === "arbeitet") throw new HttpFehler(409, "Der Bot arbeitet gerade noch daran – gleich nochmal versuchen.");
      if (["gepostet", "geplant", "verworfen"].includes(a.status)) throw new HttpFehler(409, `Der Beitrag ist schon ${a.status}.`);
      auftraege.aendern(a.id, { plattform: "web", chat: nutzer, chatId: `web|${nutzer}`, freigabe: null, wartetAuf: null, status: a.ergebnis ? "bereit" : "entwurf" });
      protokoll("uebernommen", { nutzer, ip, auftrag: a.id });
      if (a.art === "video") hintergrund(a, (schritt) => werkstatt.analysieren(a, schritt, { arbeitskopien: true }));
      return senden(res, 200, ansicht(a, werkstatt));
    }

    if (bereich !== "auftrag" || !id) throw new HttpFehler(404, "Unbekannte Adresse.");
    const a = eigenerAuftrag(nutzer, id);
    const beschaeftigt = () => {
      if (a.status === "arbeitet") throw new HttpFehler(409, "Moment, ich bin noch dran …");
    };
    const fertig = ["gepostet", "geplant"].includes(a.status);
    const speichern = async (daten) => {
      if (fertig) return;
      if (daten.e) {
        const e = bereinigen(daten.e, a.e, ppicng);
        auftraege.aendern(a.id, { e, geaendert: true });
      }
      if (a.art === "video") {
        const clips = werkstatt.clips(a);
        try {
          if (daten.schnitt !== undefined) werkstatt.schnittSetzen(a, schnittPruefen(daten.schnitt, clips));
          if (daten.untertitel !== undefined) {
            werkstatt.cuesSchreiben(a, cuesPruefen(daten.untertitel, clips));
            auftraege.aendern(a.id, { geaendert: true });
          }
        } catch (e) {
          throw new HttpFehler(400, e.message);
        }
        if (typeof daten.srt === "string") {
          werkstatt.srtUebernehmen(a, daten.srt.slice(0, 200000));
          auftraege.aendern(a.id, { geaendert: true });
        }
      }
      if (typeof daten.caption === "string") auftraege.aendern(a.id, { caption: daten.caption.slice(0, 20000), captions: {} });
      if (Array.isArray(daten.kanaele)) auftraege.aendern(a.id, { kanaele: daten.kanaele.filter((k) => typeof k === "string").slice(0, 50) });
    };

    switch (`${m} ${aktion ?? ""}`) {
      case "GET ":
        return senden(res, 200, ansicht(a, werkstatt));
      case "POST speichern":
        await speichern(await jsonLesen(req));
        return senden(res, 200, ansicht(a, werkstatt));
      case "POST verwerfen":
        auftraege.aendern(a.id, { status: "verworfen" });
        return senden(res, 200, { ok: true });

      // Vorschau mit den Einstellungen aus dem Browser, ohne sie zu speichern
      case "POST vorschau": {
        const daten = await jsonLesen(req);
        const e = bereinigen(daten.e, a.e, ppicng);
        if (a.art === "sharepic") return senden(res, 200, (await werkstatt.sharepicPng(a, e)).png, { "Content-Type": "image/png" });
        if (!werkstatt.clips(a).length) throw new HttpFehler(409, "Das Video ist noch nicht angekommen.");
        const zeit = Number.isFinite(Number(daten.zeit)) && daten.zeit !== null ? Number(daten.zeit) : null;
        const { datei, lage } = await werkstatt.arbeit(() => werkstatt.standbild(a, e, zeit));
        return senden(res, 200, await fsp.readFile(datei), { "Content-Type": "image/jpeg", "X-Lage": lage.lage });
      }
      case "POST karte": {
        const daten = await jsonLesen(req);
        const art = daten.art === "abspann" ? "abspann" : "titelkarte";
        const e = bereinigen(daten.e, a.e, ppicng);
        if (art === "abspann" && !e.abspann) e.abspann = { claim: e.abspannText };
        const png = await werkstatt.kartePng(a, art, e);
        if (!png) throw new HttpFehler(404, "Keine Karte.");
        return senden(res, 200, png, { "Content-Type": "image/png" });
      }
      // Eigenes Bild für Titelkarte, Abspann oder als Foto des Sharepics
      // Hintergrundmusik hochladen bzw. zum Vorhören abrufen
      case "POST musik": {
        if (a.art !== "video") throw new HttpFehler(400, "Nur für Videos.");
        beschaeftigt();
        grenzenPruefen(nutzer, ip, { upload: true });
        const name = path.basename(url.searchParams.get("name") ?? "musik.mp3");
        const datei = path.join(a.ordner, `musik-${Date.now()}${sichereEndung(name, "ton")}`);
        await dateiLesen(req, datei);
        try {
          await werkstatt.musikSetzen(a, datei, name);
        } catch (e) {
          await fsp.rm(datei, { force: true });
          throw new HttpFehler(400, `Die Musik ließ sich nicht lesen: ${e.message.split("\n")[0]}`);
        }
        return senden(res, 200, ansicht(a, werkstatt));
      }
      case "GET musik":
        return dateiSenden(req, res, a.e.ton?.musik?.datei);

      case "POST bild": {
        beschaeftigt();
        const zweck = aus(url.searchParams.get("zweck"), ["titelkarte", "abspann", "foto"], null);
        if (!zweck) throw new HttpFehler(400, "zweck fehlt.");
        grenzenPruefen(nutzer, ip, { upload: true });
        const roh = path.join(a.ordner, `eingang-${Date.now()}`);
        await dateiLesen(req, roh);
        const bild = path.join(a.ordner, `${zweck}-${Date.now()}.png`);
        try {
          await fotoNormalisieren(roh, bild);
        } catch (e) {
          throw new HttpFehler(400, `Das Bild ließ sich nicht lesen: ${e.message.split("\n")[0]}`);
        } finally {
          await fsp.rm(roh, { force: true });
        }
        const e = { ...a.e };
        if (zweck === "titelkarte") e.titelkarte = { bild };
        else if (zweck === "abspann") Object.assign(e, { abspann: { bild }, abspannAn: true });
        else Object.assign(e, { bild, bildStil: e.bildStil === "logo" && e.claim ? "geteilt" : e.bildStil });
        auftraege.aendern(a.id, { e, geaendert: true });
        return senden(res, 200, ansicht(a, werkstatt));
      }
      case "POST bauen": {
        beschaeftigt();
        if (a.art === "video" && offen(nutzer).filter((x) => x.status === "arbeitet").length >= 2) throw new HttpFehler(429, "Bei dir laufen schon zwei Aufträge – bitte warten.");
        if (fertig) throw new HttpFehler(409, "Schon gepostet.");
        await speichern(await jsonLesen(req));
        // Noch kein Beitragstext (Sharepic aus dem Browser): Vorschlag aus Claim und Erklärtext bzw. per KI
        if (!a.caption?.trim()) await werkstatt.captionErzeugen(a);
        if (a.art === "sharepic") {
          await werkstatt.bauen(a);
          return senden(res, 200, ansicht(a, werkstatt));
        }
        hintergrund(a, (schritt) => werkstatt.bauen(a, schritt));
        return senden(res, 200, ansicht(a, werkstatt));
      }
      case "POST ki": {
        if (!config.caption.anbieter) throw new HttpFehler(400, "Keine KI eingerichtet.");
        const { hinweis = "" } = await jsonLesen(req);
        await speichern({});
        await werkstatt.captionErzeugen(a, String(hinweis).slice(0, 500));
        return senden(res, 200, ansicht(a, werkstatt));
      }
      case "GET datei": {
        const name = `piraten-${a.art}-${a.id}${path.extname(a.ergebnis ?? "")}`;
        return dateiSenden(req, res, a.ergebnis, { name, herunterladen: true });
      }
      case "GET vorschaudatei":
        return dateiSenden(req, res, a.vorschauDatei);
      case "GET srt":
        return dateiSenden(req, res, werkstatt.srtFuerAusgabe(a), { name: `untertitel-${a.id}.srt`, herunterladen: true });

      // Weitere Clips für den Schnitt
      case "POST clip": {
        if (a.art !== "video") throw new HttpFehler(400, "Nur für Videos.");
        if (fertig) throw new HttpFehler(409, "Schon gepostet.");
        if (clipId) {
          if (clipAktion !== "entfernen") throw new HttpFehler(404, "Unbekannte Adresse.");
          beschaeftigt();
          try {
            werkstatt.clipEntfernen(a, clipId);
          } catch (e) {
            throw new HttpFehler(400, e.message);
          }
          auftraege.aendern(a.id, { geaendert: true });
          return senden(res, 200, ansicht(a, werkstatt));
        }
        if (werkstatt.clips(a).length >= 30) throw new HttpFehler(400, "Höchstens 30 Clips je Video.");
        grenzenPruefen(nutzer, ip, { upload: true });
        const name = path.basename(url.searchParams.get("name") ?? "clip.mp4");
        const datei = path.join(a.ordner, `clip-${Date.now()}${sichereEndung(name, "video")}`);
        await dateiLesen(req, datei);
        groesseVergessen(config.datenDir);
        try {
          await laengePruefen(datei);
          await werkstatt.clipHinzufuegen(a, datei, name);
        } catch (e) {
          await fsp.rm(datei, { force: true });
          if (e instanceof HttpFehler) throw e;
          throw new HttpFehler(400, `Das Video ließ sich nicht lesen: ${e.message.split("\n")[0]}`);
        }
        auftraege.aendern(a.id, { geaendert: true });
        if (a.status !== "arbeitet") hintergrund(a, (schritt) => werkstatt.analysieren(a, schritt, { arbeitskopien: true }));
        else werkstatt.arbeit(() => werkstatt.analysieren(a, () => {}, { arbeitskopien: true })).catch((e) => console.error(e));
        return senden(res, 200, ansicht(a, werkstatt));
      }
      case "GET clip": {
        const clip = werkstatt.clips(a).find((c) => c.id === clipId);
        const k = clip?.arbeitskopie;
        if (!k) throw new HttpFehler(404, "Die Arbeitskopie ist noch nicht fertig.");
        const datei = { arbeitskopie: k.video, streifen: k.streifen, welle: k.welle }[clipAktion];
        return dateiSenden(req, res, datei);
      }

      case "GET kanaele": {
        if (!darfPosten(nutzer)) throw new HttpFehler(403, "Posten ist für dich nicht freigeschaltet.");
        const alle = await werkstatt.alleKanaele();
        const moeglich = new Set((await werkstatt.kanaeleFuer({ ...a, kunde: null })).map((c) => c.id));
        const eigene = werkstatt.postiz.eigeneEinstellungen();
        return senden(res, 200, {
          kanaele: alle.filter((c) => moeglich.has(c.id)).map((c) => ({ id: c.id, name: c.name, identifier: c.identifier, kunde: c.customer?.name ?? null, max: zeichenLimit(c, eigene) })),
          kunden: kundenAus(alle).map((k) => k.name),
          gewaehlt: a.kanaele ?? [],
        });
      }
      case "POST posten": {
        if (!darfPosten(nutzer)) throw new HttpFehler(403, "Posten ist für dich nicht freigeschaltet.");
        beschaeftigt();
        if (fertig) throw new HttpFehler(409, "Schon gepostet.");
        if (!a.ergebnis || a.geaendert) throw new HttpFehler(409, "Erst bauen – die Vorschau ist nicht auf dem neuesten Stand.");
        const daten = await jsonLesen(req);
        await speichern({ caption: daten.caption, kanaele: daten.kanaele });
        const zeit = daten.zeit ? new Date(daten.zeit) : null;
        if (zeit && (Number.isNaN(zeit.getTime()) || zeit < new Date())) throw new HttpFehler(400, "Der Zeitpunkt liegt in der Vergangenheit.");
        const kanaele = (await werkstatt.alleKanaele()).filter((c) => a.kanaele.includes(c.id));
        if (!kanaele.length) throw new HttpFehler(400, "Keine Kanäle gewählt.");
        let probleme = werkstatt.zuLang(a, kanaele);
        if (probleme && daten.kuerzen) {
          const captions = {};
          for (const p of probleme) captions[p.c.id] = kuerzen(a.caption, p.max, (t) => zeichenZahl(t, p.c.identifier));
          auftraege.aendern(a.id, { captions });
          probleme = werkstatt.zuLang(a, kanaele);
        }
        if (probleme) throw new HttpFehler(422, "Der Text ist für einige Kanäle zu lang.", { probleme: probleme.map((p) => ({ name: p.c.name, n: p.n, max: p.max })) });
        const frei = werkstatt.wiederFrei(a);
        if (frei) throw new HttpFehler(429, frei === Infinity ? "Postiz-Anfragenlimit zu klein (POSTIZ_MAX_ANFRAGEN)." : `Postiz-Anfragenlimit erreicht – wieder frei ab ${zeitText(frei)}.`);
        auftraege.aendern(a.id, { status: "arbeitet", schritt: "📤 Lade zu Postiz hoch …" });
        try {
          await werkstatt.posten(a, zeit);
        } catch (e) {
          auftraege.aendern(a.id, { status: "bereit", schritt: "" });
          throw new HttpFehler(502, `Postiz hat nicht mitgespielt: ${e.message.slice(0, 800)}`);
        }
        auftraege.aendern(a.id, { schritt: "" });
        protokoll(zeit ? "geplant" : "gepostet", { nutzer, ip, auftrag: a.id, kanaele: kanaele.map((c) => c.name), zeit: zeit?.toISOString() });
        return senden(res, 200, ansicht(a, werkstatt));
      }
    }
    throw new HttpFehler(404, "Unbekannte Adresse.");
  }

  async function anmelden(req, res, ip) {
    if (!w.anmeldung) throw new HttpFehler(400, "Hier braucht es keine Anmeldung.");
    if (!grenzen.anmeldungAdresse.frei(ip)) throw new HttpFehler(429, "Zu viele Versuche – bitte in 15 Minuten nochmal.");
    const { nutzer = "", passwort = "", art = "" } = await jsonLesen(req, 10000);
    const name = String(nutzer).trim().slice(0, 80);
    if (!grenzen.anmeldungName.frei(name.toLowerCase())) throw new HttpFehler(429, "Zu viele Versuche für diesen Namen – bitte später nochmal.");
    let wer = null;
    let sitzungsArt = null;
    const perMatrix = w.matrixAnmeldung && name && (art === "matrix" || !w.passwort);
    if (perMatrix) {
      const id = await matrixPruefen(w.matrixUrl, name, String(passwort).slice(0, 1000));
      if (id && !istErlaubt(w.erlaubt, id, "")) {
        protokoll("anmeldung-abgelehnt", { ip, nutzer: id, grund: "nicht in WEB_ERLAUBT" });
        throw new HttpFehler(403, `${id} ist für die Web-Version nicht freigeschaltet.`);
      }
      wer = id;
      sitzungsArt = "matrix";
    } else if (w.passwort && passwort && gleich(passwort, w.passwort)) {
      wer = `team:${name.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40) || "team"}`;
      sitzungsArt = "passwort";
    }
    if (!wer) {
      grenzen.anmeldungAdresse.zaehlen(ip);
      grenzen.anmeldungName.zaehlen(name.toLowerCase());
      protokoll("anmeldung-fehlgeschlagen", { ip, nutzer: name, art: perMatrix ? "matrix" : "passwort" });
      throw new HttpFehler(401, "Anmeldung fehlgeschlagen.");
    }
    // Alte Sitzung (z. B. Gast) ersetzen – keine Übernahme fremder Sitzungen
    sitzungen.loeschen(cookies(req)[COOKIE]);
    const schluessel = sitzungen.erstellen(wer, { art: sitzungsArt, merkmal: sitzungsArt === "passwort" ? passwortMerkmal(geheimnis, w.passwort) : null, tage: SITZUNG_TAGE });
    protokoll("anmeldung", { ip, nutzer: wer, art: sitzungsArt });
    senden(res, 200, { nutzer: wer }, { "Set-Cookie": cookieSetzen(schluessel, SITZUNG_TAGE) });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (sicher) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const ip = clientAdresse(req, w.proxy);
    try {
      const url = new URL(req.url, "http://localhost");
      if (STATISCH[url.pathname] && req.method === "GET") {
        const [datei, typ] = STATISCH[url.pathname];
        res.writeHead(200, { "Content-Type": typ, "Cache-Control": "no-cache" });
        return fs.createReadStream(path.join(WEB_DIR, datei)).pipe(res);
      }
      const schrift = url.pathname.match(/^\/schriften\/(claim|text|fett)\.otf$/);
      if (schrift) return dateiSenden(req, res, ppicng.schriften[schrift[1]]);

      if (!url.pathname.startsWith("/api/")) throw new HttpFehler(404, "Nicht gefunden.");
      if (!["GET", "HEAD", "POST"].includes(req.method)) throw new HttpFehler(405, "Methode nicht erlaubt.");
      if (req.method === "POST") {
        // Schutz vor Anfragen fremder Seiten: eigener Kopf (geht nur per Skript von derselben Seite) und Origin
        if (req.headers["x-ppb"] !== "1") throw new HttpFehler(403, "Anfrage ohne X-PPB-Kopf.");
        const origin = req.headers.origin;
        if (origin && origin !== "null") {
          let host = null;
          try {
            host = new URL(origin).host;
          } catch {}
          if (host !== req.headers.host) throw new HttpFehler(403, "Anfrage von einer fremden Seite.");
        }
      }
      if (url.pathname === "/api/anmelden" && req.method === "POST") return await anmelden(req, res, ip);
      if (url.pathname === "/api/abmelden" && req.method === "POST") {
        const wer = nutzerAus(req);
        sitzungen.loeschen(cookies(req)[COOKIE]);
        if (wer) protokoll("abmeldung", { ip, nutzer: wer });
        return senden(res, 200, { ok: true }, { "Set-Cookie": cookieSetzen("", 0) });
      }
      let nutzer = nutzerAus(req);
      if (url.pathname === "/api/ich") {
        const kopf = {};
        // Offener Modus: jeder Browser bekommt eine Gast-Sitzung (Projekte gehören diesem Browser)
        if (!nutzer && !w.anmeldung && grenzen.gaeste.erlauben(ip)) {
          nutzer = `gast:${crypto.randomBytes(9).toString("base64url")}`;
          kopf["Set-Cookie"] = cookieSetzen(sitzungen.erstellen(nutzer, { art: "gast", tage: 30 }), 30);
        }
        return senden(res, 200, {
          nutzer,
          modus: w.anmeldung ? "anmeldung" : "offen",
          anmeldung: { passwort: Boolean(w.passwort), matrix: w.matrixAnmeldung, matrixServer: w.matrixAnmeldung ? new URL(w.matrixUrl).host : null },
        }, kopf);
      }
      if (!nutzer) throw new HttpFehler(401, "Bitte anmelden.");
      await api(req, res, url, nutzer, ip);
    } catch (e) {
      const status = e instanceof HttpFehler ? e.status : 500;
      let meldung = e.message;
      if (status === 500) {
        // Keine Interna (Pfade, Fehlertexte) nach außen – nur eine Nummer zum Wiederfinden im Protokoll
        const nummer = crypto.randomBytes(4).toString("hex");
        console.error(`Web-Fehler ${nummer}:`, e);
        meldung = `Interner Fehler (${nummer}) – bitte nochmal versuchen oder den Admins die Nummer nennen.`;
      }
      if (!res.headersSent) senden(res, status, { fehler: meldung, ...(e.daten ?? {}) });
      else res.destroy();
    }
  });
  // Große Uploads dürfen dauern, langsames Senden der Köpfe nicht (Slowloris)
  server.headersTimeout = 20e3;
  server.requestTimeout = 60 * 60e3;
  server.keepAliveTimeout = 5e3;
  server.maxHeadersCount = 60;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(w.port, w.adresse, resolve);
  });
  werkstatt.webServer = server;
  return `http://${w.adresse}:${server.address().port}`;
}
