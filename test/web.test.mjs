import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bereinigen } from "../src/web.mjs";
import { Sitzungen, Begrenzer, clientAdresse, passwortMerkmal, protokollierer } from "../src/websicherheit.mjs";
import { ladePpicng } from "../src/ppicng.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
const ordner = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppb-web-"));

test("Sitzungen: auf dem Server, nur Hash gespeichert, laufen ab, Abmelden löscht", () => {
  const datei = path.join(ordner(), "s.json");
  const s = new Sitzungen(datei);
  const jetzt = Date.now();
  const schluessel = s.erstellen("@anja:piratenpartei.de", { art: "matrix", tage: 14, jetzt });
  assert.ok(schluessel.length >= 40);
  assert.equal(s.lesen(schluessel, jetzt + 1000).nutzer, "@anja:piratenpartei.de");
  // Datei enthält den Schlüssel nicht im Klartext und ist nur für den Bot lesbar
  assert.ok(!fs.readFileSync(datei, "utf8").includes(schluessel));
  assert.equal(fs.statSync(datei).mode & 0o077, 0);
  assert.equal(s.lesen(schluessel, jetzt + 15 * 864e5), null);
  assert.equal(s.lesen("x".repeat(43), 2000), null);
  assert.equal(s.lesen(undefined), null);
  assert.equal(s.lesen("a".repeat(500)), null);
  // Nach Neustart noch da, nach Abmelden weg
  assert.equal(new Sitzungen(datei).lesen(schluessel).nutzer, "@anja:piratenpartei.de");
  s.loeschen(schluessel);
  assert.equal(new Sitzungen(datei).lesen(schluessel), null);
});

test("Passwort-Merkmal ändert sich mit dem Passwort und verrät es nicht", () => {
  const a = passwortMerkmal("geheimnis", "segel-setzen-ahoi");
  assert.equal(a, passwortMerkmal("geheimnis", "segel-setzen-ahoi"));
  assert.notEqual(a, passwortMerkmal("geheimnis", "neues-passwort-123"));
  assert.notEqual(a, passwortMerkmal("anderes", "segel-setzen-ahoi"));
  assert.ok(!a.includes("segel"));
});

test("Begrenzer zählt im Zeitfenster", () => {
  const b = new Begrenzer(2, 1000);
  assert.ok(b.erlauben("ip", 0));
  assert.ok(b.erlauben("ip", 100));
  assert.ok(!b.erlauben("ip", 200));
  assert.ok(b.erlauben("andere", 200));
  assert.ok(b.frei("ip", 1101));
  assert.ok(b.erlauben("ip", 1101));
});

test("Client-Adresse: Proxy-Köpfe nur, wenn dem Proxy vertraut wird", () => {
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9", "x-real-ip": "" } };
  assert.equal(clientAdresse(req, false), "127.0.0.1");
  assert.equal(clientAdresse(req, true), "9.9.9.9"); // der letzte Eintrag stammt vom eigenen Proxy
  assert.equal(clientAdresse({ ...req, headers: { ...req.headers, "x-real-ip": "5.5.5.5" } }, true), "5.5.5.5");
});

test("Protokoll schreibt JSON-Zeilen", () => {
  const datei = path.join(ordner(), "p.log");
  const p = protokollierer(datei);
  p("anmeldung", { nutzer: "team:Anja", ip: "1.2.3.4" });
  p("gepostet", { nutzer: "team:Anja" });
  const zeilen = fs.readFileSync(datei, "utf8").trim().split("\n").map((z) => JSON.parse(z));
  assert.deepEqual(zeilen.map((z) => z.ereignis), ["anmeldung", "gepostet"]);
  assert.equal(fs.statSync(datei).mode & 0o077, 0);
});

test("Einstellungen aus dem Browser: nur Bekanntes, keine Dateipfade", () => {
  const alt = { design: "weiss-schwarz-orange", logo: "common/piraten", format: "9:16", bild: "/daten/foto.png", titelkarte: { bild: "/daten/karte.png" }, abspann: null, untertitel: true, claim: "",
    ton: { angleichen: true, rauschen: false, musik: { datei: "/daten/musik.mp3", name: "m.mp3", dauer: 60, lautstaerke: 0.25, ducking: true, ab: 0 } } };
  const e = bereinigen({
    design: "pink", logo: "laender/bayern", format: "../../etc", bild: "/etc/passwd", claim: "x".repeat(1000), untertitel: "ja",
    titelkarte: { art: "bild", bild: "/etc/shadow" }, abspann: { art: "text", claim: "piraten.de", bild: "/etc/passwd" }, boese: 1,
    ton: { angleichen: false, rauschen: true, musik: { datei: "/etc/passwd", lautstaerke: 5, ab: 999, ducking: false } },
  }, alt, ppicng);
  assert.equal(e.design, "weiss-schwarz-orange");
  assert.equal(e.logo, "laender/bayern");
  assert.equal(e.format, "9:16");
  assert.equal(e.bild, "/daten/foto.png");
  assert.equal(e.claim.length, 300);
  assert.equal(e.untertitel, true);
  assert.deepEqual(e.titelkarte, { bild: "/daten/karte.png" });
  assert.deepEqual(e.abspann, { claim: "piraten.de", text: "" });
  assert.equal("boese" in e, false);
  assert.deepEqual(e.ton, { angleichen: false, rauschen: true, musik: { datei: "/daten/musik.mp3", name: "m.mp3", dauer: 60, lautstaerke: 1, ducking: false, ab: 59 } });
  assert.equal(bereinigen({ ton: { musik: null } }, alt, ppicng).ton.musik, null);
  assert.equal(bereinigen({ logo: "gibt/esnicht" }, alt, ppicng).logo, "common/piraten");
  assert.equal(bereinigen({ titelkarte: null }, alt, ppicng).titelkarte, null);
});
