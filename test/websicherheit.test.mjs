// Sicherheit der Web-Version gegen den laufenden Bot: Modi, Sitzungen, Grenzen, fremde Seiten, fremde Dateien.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

const WURZEL = new URL("..", import.meta.url).pathname;
const laufende = [];
after(() => laufende.forEach((p) => p.kill()));

const freierPort = () => new Promise((r) => {
  const s = net.createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});

/** Bot starten; wartet auf „web: …“ oder das Ende des Prozesses. */
async function starten(env) {
  const port = await freierPort();
  const p = spawn(process.execPath, ["src/bot.mjs"], {
    cwd: WURZEL,
    env: { PATH: process.env.PATH, WEB_PORT: String(port), CHATS: "/gibt/es/nicht.json", GESICHT_PYTHON: "/gibt/es/nicht", ...env },
  });
  laufende.push(p);
  let ausgabe = "";
  p.stdout.on("data", (d) => (ausgabe += d));
  p.stderr.on("data", (d) => (ausgabe += d));
  const ende = new Promise((r) => p.on("exit", (code) => r(code)));
  for (let i = 0; i < 300; i++) {
    if (/web: http/.test(ausgabe)) return { basis: `http://127.0.0.1:${port}`, prozess: p, ausgabe: () => ausgabe };
    if (p.exitCode !== null) return { beendet: await ende, ausgabe: () => ausgabe };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Startet nicht:\n${ausgabe}`);
}

const daten = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppb-sicher-"));

function client(basis) {
  let cookie = "";
  const api = async (pfad, { methode = "GET", json, body, typ, kopf = {}, ohneSchutz = false } = {}) => {
    const res = await fetch(`${basis}/api/${pfad}`, {
      method: methode,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(methode === "POST" && !ohneSchutz ? { "X-PPB": "1" } : {}),
        ...(json ? { "Content-Type": "application/json" } : typ ? { "Content-Type": typ } : {}),
        ...kopf,
      },
      body: json ? JSON.stringify(json) : body,
    });
    const gesetzt = res.headers.get("set-cookie");
    if (gesetzt) cookie = gesetzt.split(";")[0];
    return res;
  };
  return { api, cookie: () => cookie, setzeCookie: (c) => (cookie = c) };
}

test("Postiz ohne Anmeldung startet nicht, zu kurzes Passwort auch nicht", async () => {
  const a = await starten({ DATEN_DIR: daten(), POSTIZ_URL: "http://127.0.0.1:9", POSTIZ_API_KEY: "x" });
  assert.notEqual(a.beendet, undefined);
  assert.match(a.ausgabe(), /Mit Postiz braucht die Web-Version eine Anmeldung/);
  const b = await starten({ DATEN_DIR: daten(), WEB_PASSWORT: "kurz" });
  assert.match(b.ausgabe(), /mindestens 12 Zeichen/);
  const c = await starten({ DATEN_DIR: daten(), WEB_MATRIX_ANMELDUNG: "ja", WEB_ERLAUBT: "*:x.de", WEB_MATRIX_URL: "http://matrix.example.de" });
  assert.match(c.ausgabe(), /muss mit https:\/\/ beginnen/);
});

test("Offen ohne Postiz: Gäste getrennt, Grenzen, Schutz vor fremden Seiten und Dateien", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 120000 }, async () => {
  const ordner = daten();
  const { basis } = await starten({ DATEN_DIR: ordner, WEB_UPLOADS_PRO_STUNDE: "3", WEB_OFFENE_PROJEKTE: "2" });

  // Sicherheitsköpfe
  const seite = await fetch(basis);
  for (const kopf of ["content-security-policy", "x-frame-options", "cross-origin-opener-policy", "permissions-policy", "x-content-type-options"]) {
    assert.ok(seite.headers.get(kopf), kopf);
  }

  const anja = client(basis);
  const bob = client(basis);
  const ichA = await (await anja.api("ich")).json();
  const ichB = await (await bob.api("ich")).json();
  assert.equal(ichA.modus, "offen");
  assert.match(ichA.nutzer, /^gast:/);
  assert.notEqual(ichA.nutzer, ichB.nutzer);
  assert.match(anja.cookie(), /^ppb=/);
  assert.equal((await anja.api("anmelden", { methode: "POST", json: { passwort: "x" } })).status, 400);
  const optionen = await (await anja.api("optionen")).json();
  assert.equal(optionen.posten, false);
  assert.ok(optionen.uebergaenge.blende);

  // Ohne Sitzung nichts
  assert.equal((await client(basis).api("optionen")).status, 401);

  // Fremde Seiten: ohne X-PPB-Kopf oder mit fremdem Origin abgelehnt
  assert.equal((await anja.api("sharepic", { methode: "POST", json: {}, ohneSchutz: true })).status, 403);
  assert.equal((await anja.api("sharepic", { methode: "POST", json: {}, kopf: { Origin: "https://boese.example" } })).status, 403);
  assert.equal((await anja.api("sharepic", { methode: "DELETE" })).status, 405);

  // Projekte gehören dem Browser
  const sp = await (await anja.api("sharepic", { methode: "POST", json: { e: { claim: "Anjas Bild" } } })).json();
  assert.equal((await anja.api(`auftrag/${sp.id}`)).status, 200);
  assert.equal((await bob.api(`auftrag/${sp.id}`)).status, 404);
  assert.equal((await bob.api(`auftrag/${sp.id}/datei`)).status, 404);
  assert.equal((await anja.api(`auftrag/${sp.id}/posten`, { methode: "POST", json: {} })).status, 403);

  // Getarnte Playlist, die Dateien des Servers einbinden will: abgelehnt, nichts gerendert
  const playlist = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n";
  const boese = await bob.api("hochladen?name=liste.m3u8", { methode: "POST", body: playlist, typ: "video/mp4" });
  assert.equal(boese.status, 400);
  const concat = await bob.api("hochladen?name=x.mp4", { methode: "POST", body: "ffconcat version 1.0\nfile /etc/passwd\n", typ: "video/mp4" });
  assert.equal(concat.status, 400);

  // Grenzen: höchstens 2 offene Projekte, 3 Uploads je Stunde und Adresse
  assert.equal((await anja.api("sharepic", { methode: "POST", json: {} })).status, 200);
  const zuViele = await anja.api("sharepic", { methode: "POST", json: {} });
  assert.equal(zuViele.status, 429);
  assert.match((await zuViele.json()).fehler, /offene Projekte/);
  const dritter = await bob.api("hochladen?name=x.jpg", { methode: "POST", body: "kein bild", typ: "image/jpeg" });
  assert.equal(dritter.status, 400); // dritter Upload dieser Adresse (zwei schon oben)
  const vierter = await bob.api("hochladen?name=x.jpg", { methode: "POST", body: "kein bild", typ: "image/jpeg" });
  assert.equal(vierter.status, 429);

  // Fehlermeldungen verraten keine Pfade des Servers
  const text = JSON.stringify(await boese.json().catch(() => ({})));
  assert.doesNotMatch(text, new RegExp(ordner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Mit Anmeldung: Sperre gegen Raten, Abmelden wirkt, neues Passwort beendet alte Sitzungen", { timeout: 120000 }, async () => {
  const ordner = daten();
  const erster = await starten({ DATEN_DIR: ordner, WEB_PASSWORT: "segel-setzen-ahoi", WEB_URL: "https://posting.example.de" });
  const anja = client(erster.basis);
  const ich = await (await anja.api("ich")).json();
  assert.equal(ich.modus, "anmeldung");
  assert.equal(ich.nutzer, null);
  assert.equal(anja.cookie(), ""); // keine Gast-Sitzung im Anmelde-Modus

  const ok = await anja.api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi", nutzer: "Anja<script>" } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).nutzer, "team:Anjascript");
  assert.match(ok.headers.get("set-cookie"), /^__Host-ppb=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.equal(ok.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal((await anja.api("optionen")).status, 200);

  // Abmelden löscht die Sitzung auf dem Server – das alte Cookie nützt nichts mehr
  const altesCookie = anja.cookie();
  await anja.api("abmelden", { methode: "POST" });
  anja.setzeCookie(altesCookie);
  assert.equal((await anja.api("optionen")).status, 401);

  // Raten wird nach 10 Fehlversuchen gesperrt – auch mit richtigem Passwort
  const ratende = client(erster.basis);
  for (let i = 0; i < 10; i++) assert.equal((await ratende.api("anmelden", { methode: "POST", json: { passwort: `falsch-${i}-xxxxxxxx` } })).status, 401);
  assert.equal((await ratende.api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi" } })).status, 429);

  // Sitzung anlegen, dann Passwort ändern (Neustart) – die Sitzung gilt nicht mehr
  const bob = client(erster.basis);
  await new Promise((r) => setTimeout(r, 10));
  // (eigene Adresse ist gesperrt – Bob kommt über einen „anderen Proxy-Client“)
  const bobLogin = await bob.api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi", nutzer: "Bob" }, kopf: { "X-Real-IP": "10.0.0.2" } });
  assert.equal(bobLogin.status, 200);
  assert.equal((await bob.api("optionen")).status, 200);
  erster.prozess.kill();
  await new Promise((r) => erster.prozess.on("exit", r));
  const zweiter = await starten({ DATEN_DIR: ordner, WEB_PASSWORT: "neue-passphrase-2026", WEB_URL: "https://posting.example.de", WEB_PORT: erster.basis.split(":").at(-1) });
  assert.ok(zweiter.basis, zweiter.ausgabe());
  assert.equal((await bob.api("optionen")).status, 401);

  // Sicherheitsprotokoll
  const protokoll = fs.readFileSync(path.join(ordner, "web-protokoll.log"), "utf8").trim().split("\n").map((z) => JSON.parse(z));
  assert.ok(protokoll.some((z) => z.ereignis === "anmeldung" && z.nutzer === "team:Bob" && z.ip === "10.0.0.2"));
  assert.equal(protokoll.filter((z) => z.ereignis === "anmeldung-fehlgeschlagen").length, 10);
  assert.ok(protokoll.some((z) => z.ereignis === "abmeldung"));
});
