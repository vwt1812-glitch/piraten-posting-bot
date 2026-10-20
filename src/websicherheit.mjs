// Sicherheit der Web-Version: Sitzungen, Begrenzungen, Client-Adresse, Protokoll.
//
// Sitzungen liegen auf dem Server (daten/web-sitzungen.json), im Cookie steht nur ein zufälliger Schlüssel;
// gespeichert wird davon nur der SHA-256-Hash. Abmelden löscht die Sitzung wirklich. Sitzungen mit dem
// Team-Passwort tragen einen Fingerabdruck des Passworts – wird es geändert, sind alle sofort ungültig.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

/** Fingerabdruck des Team-Passworts (ändert sich mit dem Passwort, verrät es aber nicht). */
export const passwortMerkmal = (geheimnis, passwort) => crypto.createHmac("sha256", geheimnis).update(`passwort:${passwort}`).digest("hex").slice(0, 16);

export class Sitzungen {
  constructor(datei) {
    this.datei = datei;
    try {
      this.alle = JSON.parse(fs.readFileSync(datei, "utf8"));
    } catch {
      this.alle = {};
    }
    this.aufraeumen();
  }

  #speichern() {
    const tmp = `${this.datei}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.alle), { mode: 0o600 });
    fs.renameSync(tmp, this.datei);
  }

  /** @returns {string} Schlüssel fürs Cookie */
  erstellen(nutzer, { art, merkmal = null, tage = 14, jetzt = Date.now() } = {}) {
    const schluessel = crypto.randomBytes(32).toString("base64url");
    this.alle[hash(schluessel)] = { nutzer, art, merkmal, bis: jetzt + tage * 864e5, erstellt: jetzt };
    this.#speichern();
    return schluessel;
  }

  /** @returns {{nutzer:string, art:string, merkmal:string|null}|null} */
  lesen(schluessel, jetzt = Date.now()) {
    if (typeof schluessel !== "string" || schluessel.length < 20 || schluessel.length > 100) return null;
    const s = this.alle[hash(schluessel)];
    if (!s || s.bis <= jetzt) return null;
    return s;
  }

  loeschen(schluessel) {
    if (typeof schluessel !== "string") return;
    if (delete this.alle[hash(schluessel)]) this.#speichern();
  }

  aufraeumen(jetzt = Date.now()) {
    let geaendert = false;
    for (const [k, s] of Object.entries(this.alle)) {
      if (s.bis <= jetzt) {
        delete this.alle[k];
        geaendert = true;
      }
    }
    if (geaendert) this.#speichern();
  }
}

/** Zählt Ereignisse je Schlüssel (z. B. IP) in einem Zeitfenster. */
export class Begrenzer {
  constructor(max, fensterMs) {
    this.max = max;
    this.fenster = fensterMs;
    this.treffer = new Map();
  }

  #liste(schluessel, jetzt) {
    const liste = (this.treffer.get(schluessel) ?? []).filter((t) => jetzt - t < this.fenster);
    if (liste.length) this.treffer.set(schluessel, liste);
    else this.treffer.delete(schluessel);
    return liste;
  }

  /** Noch erlaubt? (zählt nicht) */
  frei(schluessel, jetzt = Date.now()) {
    return this.#liste(schluessel, jetzt).length < this.max;
  }

  zaehlen(schluessel, jetzt = Date.now()) {
    this.treffer.set(schluessel, [...this.#liste(schluessel, jetzt), jetzt]);
  }

  /** Prüfen und zählen in einem. */
  erlauben(schluessel, jetzt = Date.now()) {
    if (!this.frei(schluessel, jetzt)) return false;
    this.zaehlen(schluessel, jetzt);
    return true;
  }
}

/**
 * Adresse des Browsers. Hinter einem Reverse-Proxy (nginx) steht sie in X-Real-IP bzw. am Ende von
 * X-Forwarded-For – aber nur dem Proxy glauben, wenn der Bot ausschließlich lokal lauscht (sonst könnte
 * jede:r den Kopf fälschen und die Begrenzungen umgehen).
 */
export function clientAdresse(req, proxyVertrauen) {
  const direkt = req.socket.remoteAddress ?? "";
  if (!proxyVertrauen) return direkt;
  const real = String(req.headers["x-real-ip"] ?? "").trim();
  if (real) return real;
  const kette = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return kette.at(-1) ?? direkt;
}

/** Größe eines Ordners in Bytes (für die Speichergrenze), höchstens alle 60 s neu gezählt. */
const groessenCache = new Map();
export function ordnerGroesse(dir, jetzt = Date.now()) {
  const alt = groessenCache.get(dir);
  if (alt && jetzt - alt.zeit < 60e3) return alt.groesse;
  let summe = 0;
  const laufen = (d) => {
    let eintraege = [];
    try {
      eintraege = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of eintraege) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) laufen(p);
      else if (e.isFile()) summe += fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0;
    }
  };
  laufen(dir);
  groessenCache.set(dir, { zeit: jetzt, groesse: summe });
  return summe;
}
export const groesseVergessen = (dir) => groessenCache.delete(dir);

/** Sicherheitsprotokoll (Anmeldungen, Posten, Übernahmen) als JSON-Zeilen; bei 5 MB wird rotiert. */
export function protokollierer(datei) {
  return (ereignis, daten = {}) => {
    try {
      if ((fs.statSync(datei, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) fs.renameSync(datei, `${datei}.1`);
      fs.appendFileSync(datei, `${JSON.stringify({ zeit: new Date().toISOString(), ereignis, ...daten })}\n`, { mode: 0o600 });
    } catch (e) {
      console.error("Protokoll:", e.message);
    }
  };
}
