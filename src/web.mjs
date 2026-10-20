// Web-Version: dieselbe Werkstatt wie der Bot, bedienbar im Browser – wie ppicng, aber auch für Videos.
// Kein Framework, nur node:http. Die Seite selbst liegt in web/ (HTML, CSS, JS ohne Build-Schritt).
//
// Anmeldung (mindestens eins davon, sonst startet die Web-Version nicht – außer mit WEB_OFFEN=ja):
//   • WEB_PASSWORT: ein gemeinsames Passwort fürs Team
//   • WEB_MATRIX_ANMELDUNG=ja: mit dem eigenen Matrix-Konto (z. B. von matrix.piratenpartei.de), erlaubt
//     sind die Konten aus WEB_ERLAUBT (z. B. *:piratenpartei.de). Das Passwort geht nur einmal zum
//     Matrix-Server; der dabei entstandene Zugang wird sofort wieder abgemeldet.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { FARBSCHEMATA, logoNachId, logoDatei } from "./ppicng.mjs";
import { FORMATE, fotoNormalisieren } from "./video.mjs";
import { parseSrt, formatSrt, volltext } from "./untertitel.mjs";
import { kuerzen } from "./caption.mjs";
import { kundenAus, zeichenLimit, zeichenZahl } from "./postiz.mjs";
import { istErlaubt } from "./plattform/matrix.mjs";
import { SHAREPIC_FORMATE, BILDSTILE, LAGEN } from "./menues.mjs";
import { zeitText } from "./zeit.mjs";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MB = 1024 * 1024;
const SITZUNG_TAGE = 14;

const STATISCH = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/stil.css": ["stil.css", "text/css; charset=utf-8"],
};
const TYPEN = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".otf": "font/otf", ".srt": "application/x-subrip" };
const VIDEO_ENDUNG = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/i;

export class HttpFehler extends Error {
  constructor(status, text, daten) {
    super(text);
    this.status = status;
    this.daten = daten;
  }
}

// ---------- Sitzungen: signiertes Cookie, nichts auf dem Server ----------

export function sitzungErstellen(geheimnis, nutzer, jetzt = Date.now()) {
  const inhalt = Buffer.from(JSON.stringify({ n: nutzer, b: jetzt + SITZUNG_TAGE * 864e5 })).toString("base64url");
  const sig = crypto.createHmac("sha256", geheimnis).update(inhalt).digest("base64url");
  return `${inhalt}.${sig}`;
}

export function sitzungLesen(geheimnis, wert, jetzt = Date.now()) {
  const [inhalt, sig] = String(wert ?? "").split(".");
  if (!inhalt || !sig) return null;
  const soll = crypto.createHmac("sha256", geheimnis).update(inhalt).digest();
  const ist = Buffer.from(sig, "base64url");
  if (ist.length !== soll.length || !crypto.timingSafeEqual(ist, soll)) return null;
  try {
    const { n, b } = JSON.parse(Buffer.from(inhalt, "base64url").toString());
    return b > jetzt ? n : null;
  } catch {
    return null;
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
  if ("titelkarte" in neu) e.titelkarte = karte(neu.titelkarte, alt.titelkarte);
  if ("abspann" in neu) e.abspann = karte(neu.abspann, alt.abspann);
  return e;
}

/** Was der Browser über einen Auftrag erfährt (ohne Dateipfade). */
export function ansicht(a, werkstatt) {
  const karte = (k) => (k ? (k.bild ? { art: "bild" } : { art: "text", claim: k.claim ?? "", text: k.text ?? "" }) : null);
  let srt = "";
  try {
    srt = fs.readFileSync(werkstatt.srtDatei(a), "utf8");
  } catch {}
  return {
    id: a.id,
    art: a.art,
    status: a.status,
    schritt: a.schritt ?? "",
    fehler: a.fehler ?? "",
    warnungen: a.warnungen ?? [],
    erstellt: a.erstellt,
    e: { ...a.e, bild: Boolean(a.e.bild), titelkarte: karte(a.e.titelkarte), abspann: karte(a.e.abspann) },
    quelle: a.quelle ? { breite: a.quelle.breite, hoehe: a.quelle.hoehe, dauer: a.quelle.dauer, hatTon: a.quelle.hatTon } : null,
    srt,
    caption: a.caption ?? "",
    captionHinweis: a.captionHinweis ?? "",
    kanaele: a.kanaele ?? [],
    lage: a.lage ?? null,
    lageAutomatisch: Boolean(a.lageAutomatisch),
    gesichtHinweise: a.gesichtHinweise ?? [],
    gesichter: a.gesichter?.gesichter?.length ?? null,
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
  const geheimnisDatei = path.join(config.datenDir, "web-geheimnis");
  let geheimnis = w.geheimnis;
  if (!geheimnis) {
    if (!fs.existsSync(geheimnisDatei)) fs.writeFileSync(geheimnisDatei, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    geheimnis = fs.readFileSync(geheimnisDatei, "utf8").trim();
  }
  const versuche = new Map(); // IP → Zeitpunkte fehlgeschlagener Anmeldungen

  const darfPosten = (nutzer) => Boolean(werkstatt.postiz) && (w.posten === true || (Array.isArray(w.posten) && istErlaubt(w.posten, nutzer, "")));

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
        auftraege.aendern(a.id, { status: a.ergebnis ? "bereit" : "entwurf", fehler: e.message.slice(0, 1500) });
        return;
      }
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
      lagen: Object.fromEntries(Object.entries(LAGEN).filter(([l]) => l !== "auto" || werkstatt.gesichtAktiv)),
      logos: ppicng.logos.map((l) => ({ id: l.id, titel: l.titel, gruppe: l.gruppeTitel })),
      funktionen: { whisper: Boolean(config.whisper), gesicht: werkstatt.gesichtAktiv, postiz: Boolean(werkstatt.postiz), ki: Boolean(config.caption.anbieter) },
      ppicngUrl: config.ppicng.url,
      maxMb: w.maxMb,
    };
  }

  async function api(req, res, url, nutzer) {
    const teile = url.pathname.split("/").filter(Boolean); // ["api", …]
    const [, bereich, id, aktion] = teile;
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
      const daten = await jsonLesen(req);
      const a = werkstatt.neu({ plattform: "web", chat: nutzer, art: "sharepic", von: nutzer });
      auftraege.aendern(a.id, { status: "entwurf", e: bereinigen(daten.e, a.e, ppicng) });
      await werkstatt.kanaeleVorwaehlen(a);
      return senden(res, 200, ansicht(a, werkstatt));
    }

    // Neuer Beitrag: Video oder Foto hochladen
    if (bereich === "hochladen" && m === "POST") {
      const name = path.basename(url.searchParams.get("name") ?? "datei");
      const istVideo = VIDEO_ENDUNG.test(name) || String(req.headers["content-type"]).startsWith("video/");
      const a = werkstatt.neu({ plattform: "web", chat: nutzer, art: istVideo ? "video" : "sharepic", von: nutzer });
      try {
        if (istVideo) {
          const original = path.join(a.ordner, `original${path.extname(name) || ".mp4"}`);
          await dateiLesen(req, original);
          await werkstatt.videoAnnehmen(a, original);
          auftraege.aendern(a.id, { titel: name });
          await werkstatt.kanaeleVorwaehlen(a);
          hintergrund(a, async (schritt) => {
            const warnungen = await werkstatt.analysieren(a, schritt);
            await werkstatt.captionErzeugen(a);
            auftraege.aendern(a.id, { status: "entwurf", warnungen });
          });
        } else {
          const roh = path.join(a.ordner, `eingang${path.extname(name) || ".jpg"}`);
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
      if (typeof daten.srt === "string" && a.art === "video") {
        const cues = parseSrt(daten.srt.slice(0, 200000));
        await fsp.writeFile(werkstatt.srtDatei(a), formatSrt(cues));
        auftraege.aendern(a.id, { hatUntertitel: cues.length > 0, transkript: volltext(cues), geaendert: true });
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
        const e = bereinigen((await jsonLesen(req)).e, a.e, ppicng);
        if (a.art === "sharepic") return senden(res, 200, (await werkstatt.sharepicPng(a, e)).png, { "Content-Type": "image/png" });
        if (a.status === "arbeitet" && !a.quelle) throw new HttpFehler(409, "Das Video ist noch nicht angekommen.");
        const { datei, lage } = await werkstatt.arbeit(() => werkstatt.standbild(a, e));
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
      case "POST bild": {
        beschaeftigt();
        const zweck = aus(url.searchParams.get("zweck"), ["titelkarte", "abspann", "foto"], null);
        if (!zweck) throw new HttpFehler(400, "zweck fehlt.");
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
        return dateiSenden(req, res, werkstatt.srtDatei(a), { name: `untertitel-${a.id}.srt`, herunterladen: true });

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
        return senden(res, 200, ansicht(a, werkstatt));
      }
    }
    throw new HttpFehler(404, "Unbekannte Adresse.");
  }

  async function anmelden(req, res) {
    const ip = req.socket.remoteAddress ?? "";
    const jetzt = Date.now();
    const liste = (versuche.get(ip) ?? []).filter((t) => jetzt - t < 15 * 60e3);
    if (liste.length >= 10) throw new HttpFehler(429, "Zu viele Versuche – bitte in 15 Minuten nochmal.");
    const { nutzer = "", passwort = "", art = "" } = await jsonLesen(req, 10000);
    let wer = null;
    const perMatrix = w.matrixAnmeldung && nutzer && (art === "matrix" || !w.passwort);
    if (perMatrix) {
      const id = await matrixPruefen(w.matrixUrl, String(nutzer).trim(), String(passwort));
      if (id && !istErlaubt(w.erlaubt, id, "")) throw new HttpFehler(403, `${id} ist für die Web-Version nicht freigeschaltet.`);
      wer = id;
    } else if (w.passwort && passwort && gleich(passwort, w.passwort)) {
      wer = `team:${String(nutzer).trim().slice(0, 40) || "team"}`;
    }
    if (!wer) {
      versuche.set(ip, [...liste, jetzt]);
      throw new HttpFehler(401, "Anmeldung fehlgeschlagen.");
    }
    const sicher = (req.headers["x-forwarded-proto"] ?? "") === "https" || req.socket.encrypted;
    senden(res, 200, { nutzer: wer }, {
      "Set-Cookie": `ppb=${encodeURIComponent(sitzungErstellen(geheimnis, wer))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SITZUNG_TAGE * 86400}${sicher ? "; Secure" : ""}`,
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
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
      // Schutz vor Anfragen fremder Seiten: JSON-POSTs brauchen diesen Kopf, den Formulare nicht setzen können
      if (req.method !== "GET" && req.headers["x-ppb"] !== "1") throw new HttpFehler(403, "Anfrage ohne X-PPB-Kopf.");
      if (url.pathname === "/api/anmelden" && req.method === "POST") return await anmelden(req, res);
      if (url.pathname === "/api/abmelden" && req.method === "POST") {
        return senden(res, 200, { ok: true }, { "Set-Cookie": "ppb=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
      }
      const nutzer = w.offen && !w.passwort && !w.matrixAnmeldung ? "offen" : sitzungLesen(geheimnis, cookies(req).ppb);
      if (url.pathname === "/api/ich") {
        return senden(res, 200, { nutzer, anmeldung: { passwort: Boolean(w.passwort), matrix: w.matrixAnmeldung, matrixServer: w.matrixAnmeldung ? new URL(w.matrixUrl).host : null } });
      }
      if (!nutzer) throw new HttpFehler(401, "Bitte anmelden.");
      await api(req, res, url, nutzer);
    } catch (e) {
      const status = e instanceof HttpFehler ? e.status : 500;
      if (status === 500) console.error("Web:", e);
      if (!res.headersSent) senden(res, status, { fehler: status === 500 ? `Interner Fehler: ${e.message}` : e.message, ...(e.daten ?? {}) });
      else res.destroy();
    }
  });
  // Große Uploads über langsame Leitungen nicht abbrechen
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(w.port, w.adresse, resolve);
  });
  werkstatt.webServer = server;
  return `http://${w.adresse}:${server.address().port}`;
}
