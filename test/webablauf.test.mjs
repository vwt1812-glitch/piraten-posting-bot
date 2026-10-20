// Ende-zu-Ende über die HTTP-API der Web-Version: anmelden, Sharepic, Video, Schutz fremder Beiträge.

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

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-web-"));
let bot;
let ausgabe = "";
after(() => bot?.kill());

const freierPort = () => new Promise((r) => {
  const s = net.createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});

test("Web-Version über die API", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 180000 }, async () => {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(ordner, "clip.mp4")]);
  const port = await freierPort();
  bot = spawn(process.execPath, ["src/bot.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH, WEB_PORT: String(port), WEB_PASSWORT: "segel-setzen-ahoi", DATEN_DIR: path.join(ordner, "daten"),
      CHATS: path.join(ordner, "x.json"), VIDEO_PRESET: "ultrafast", VIDEO_FORMAT: "9:16", GESICHT_PYTHON: "/gibt/es/nicht",
    },
  });
  bot.stdout.on("data", (d) => (ausgabe += d));
  bot.stderr.on("data", (d) => (ausgabe += d));
  const basis = `http://127.0.0.1:${port}`;
  for (let i = 0; !/web: http/.test(ausgabe); i++) {
    if (i > 200) throw new Error(`Startet nicht:\n${ausgabe}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  let cookie = "";
  const api = async (pfad, { methode = "GET", json, body, typ, ohneKopf = false, mitCookie = cookie } = {}) => {
    const res = await fetch(`${basis}/api/${pfad}`, {
      method: methode,
      headers: { ...(mitCookie ? { Cookie: mitCookie } : {}), ...(methode !== "GET" && !ohneKopf ? { "X-PPB": "1" } : {}), ...(json ? { "Content-Type": "application/json" } : typ ? { "Content-Type": typ } : {}) },
      body: json ? JSON.stringify(json) : body,
    });
    return res;
  };

  // Seite und Schriften
  assert.match(await (await fetch(basis)).text(), /Piraten-Posting-Bot/);
  assert.equal((await fetch(`${basis}/schriften/claim.otf`)).status, 200);
  assert.match((await fetch(basis)).headers.get("content-security-policy"), /script-src 'self'/);

  // Ohne Anmeldung nichts
  assert.equal((await api("optionen")).status, 401);
  assert.equal((await api("anmelden", { methode: "POST", json: { passwort: "falsch" } })).status, 401);
  assert.equal((await api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi" }, ohneKopf: true })).status, 403);
  const anmeldung = await api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi", nutzer: "Anja" } });
  assert.equal(anmeldung.status, 200);
  cookie = anmeldung.headers.get("set-cookie").split(";")[0];
  assert.match(anmeldung.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const optionen = await (await api("optionen")).json();
  assert.equal(optionen.nutzer, "team:Anja");
  assert.ok(optionen.logos.length > 50);
  assert.equal(optionen.posten, false);
  assert.equal((await api("logo/laender/bayern?schrift=ffffff")).headers.get("content-type"), "image/png");

  // Sharepic: Live-Vorschau, fertig machen, herunterladen
  const sp = await (await api("sharepic", { methode: "POST", json: { e: { claim: "Freies WLAN", design: "lila-weiss-orange" } } })).json();
  assert.equal(sp.e.design, "lila-weiss-orange");
  const bild = await api(`auftrag/${sp.id}/vorschau`, { methode: "POST", json: { e: { claim: "Anders", sharepicFormat: "4:5" } } });
  assert.equal(bild.headers.get("content-type"), "image/png");
  assert.ok((await bild.arrayBuffer()).byteLength > 10000);
  const fertigSp = await (await api(`auftrag/${sp.id}/bauen`, { methode: "POST", json: { e: { claim: "Freies WLAN für alle" } } })).json();
  assert.equal(fertigSp.status, "bereit");
  assert.match(fertigSp.caption, /Freies WLAN für alle/);
  const datei = await api(`auftrag/${sp.id}/datei`);
  assert.match(datei.headers.get("content-disposition"), /attachment; filename="piraten-sharepic-/);
  // Posten ist nicht freigeschaltet
  assert.equal((await api(`auftrag/${sp.id}/posten`, { methode: "POST", json: {} })).status, 403);

  // Fremde sehen den Beitrag nicht
  const fremd = await api("anmelden", { methode: "POST", json: { passwort: "segel-setzen-ahoi", nutzer: "Bob" }, mitCookie: "" }); // eigener Browser
  const fremdCookie = fremd.headers.get("set-cookie").split(";")[0];
  assert.equal((await api(`auftrag/${sp.id}`, { mitCookie: fremdCookie })).status, 404);

  // Video hochladen, Analyse abwarten, Titelkarte, bauen, mit Range abrufen
  const video = await (await api("hochladen?name=clip.mp4", { methode: "POST", body: fs.readFileSync(path.join(ordner, "clip.mp4")), typ: "video/mp4" })).json();
  assert.equal(video.art, "video");
  let v = video;
  while (v.status === "arbeitet") {
    await new Promise((r) => setTimeout(r, 200));
    v = await (await api(`auftrag/${video.id}`)).json();
  }
  assert.equal(v.status, "entwurf");
  assert.equal(v.quelle.breite, 640);
  const standbild = await api(`auftrag/${video.id}/vorschau`, { methode: "POST", json: { e: { bauchbindeAn: true, bauchbinde: { name: "Anja", funktion: "Test" } } } });
  assert.equal(standbild.headers.get("content-type"), "image/jpeg");
  const karte = await api(`auftrag/${video.id}/karte`, { methode: "POST", json: { art: "titelkarte", e: { titelkarte: { art: "text", claim: "Hallo" } } } });
  assert.equal(karte.headers.get("content-type"), "image/png");
  await api(`auftrag/${video.id}/bauen`, { methode: "POST", json: { e: { titelkarte: { art: "text", claim: "Hallo" } }, srt: "1\n00:00:00,000 --> 00:00:02,000\nHallo zusammen\n" } });
  do {
    await new Promise((r) => setTimeout(r, 300));
    v = await (await api(`auftrag/${video.id}`)).json();
  } while (v.status === "arbeitet");
  assert.equal(v.status, "bereit", v.fehler);
  assert.deepEqual(v.ergebnis.masse, { breite: 1080, hoehe: 1920 });
  assert.match(v.srt, /Hallo zusammen/);
  const stueck = await api(`auftrag/${video.id}/vorschaudatei`, { mitCookie: cookie });
  assert.equal(stueck.status, 200);
  const range = await fetch(`${basis}/api/auftrag/${video.id}/vorschaudatei`, { headers: { Cookie: cookie, Range: "bytes=0-99" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);

  // Schneiden: zweiten Clip anhängen, Teile setzen, Untertitel in Clip-Zeit, neu bauen
  const zweiter = await api(`auftrag/${video.id}/clip?name=zwei.mp4`, { methode: "POST", body: fs.readFileSync(path.join(ordner, "clip.mp4")), typ: "video/mp4" });
  assert.equal(zweiter.status, 200);
  do {
    await new Promise((r) => setTimeout(r, 300));
    v = await (await api(`auftrag/${video.id}`)).json();
  } while (v.status === "arbeitet");
  assert.deepEqual(v.clips.map((c) => [c.id, c.bereit]), [["c1", true], ["c2", true]]);
  assert.deepEqual(v.schnitt.map((t) => t.clip), ["c1", "c2"]);
  assert.equal((await api(`auftrag/${video.id}/clip/c2/streifen`)).headers.get("content-type"), "image/jpeg");
  assert.equal((await api(`auftrag/${video.id}/clip/c2/welle`)).headers.get("content-type"), "image/png");
  assert.equal((await api(`auftrag/${video.id}/clip/c2/arbeitskopie`)).headers.get("content-type"), "video/mp4");
  assert.equal((await api(`auftrag/${video.id}/speichern`, { methode: "POST", json: { schnitt: [] } })).status, 400);
  const geschnitten = await (await api(`auftrag/${video.id}/speichern`, { methode: "POST", json: {
    schnitt: [{ clip: "c2", von: 0.5, bis: 1.5, lautstaerke: 0.5 }, { clip: "c1", von: 0, bis: 0.5, uebergang: { art: "blende", dauer: 0.2 } }, { clip: "c9", von: 0, bis: 1 }],
    untertitel: [{ clip: "c2", start: 600, end: 1400, text: "Erster Teil" }, { clip: "c1", start: 1000, end: 1900, text: "herausgeschnitten" }],
  } })).json();
  assert.deepEqual(geschnitten.schnitt, [{ clip: "c2", von: 0.5, bis: 1.5, lautstaerke: 0.5 }, { clip: "c1", von: 0, bis: 0.5, uebergang: { art: "blende", dauer: 0.2 } }]);
  // Der Untertitel endet, wo die Blende in den nächsten Teil beginnt
  assert.match(geschnitten.srt, /00:00:00,100 --> 00:00:00,800\nErster Teil/);
  assert.doesNotMatch(geschnitten.srt, /herausgeschnitten/);
  assert.equal(geschnitten.geaendert, true);
  await api(`auftrag/${video.id}/bauen`, { methode: "POST", json: { e: { titelkarte: null, untertitel: true } } });
  do {
    await new Promise((r) => setTimeout(r, 300));
    v = await (await api(`auftrag/${video.id}`)).json();
  } while (v.status === "arbeitet");
  assert.equal(v.status, "bereit", v.fehler);
  const fertig = path.join(ordner, "geschnitten.mp4");
  fs.writeFileSync(fertig, Buffer.from(await (await api(`auftrag/${video.id}/datei`)).arrayBuffer()));
  const dauer = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", fertig]).toString());
  assert.ok(Math.abs(dauer - 1.3) < 0.15, `Dauer ${dauer}`); // 1 + 0,5 − 0,2 Blende
  // Standbild an einer Stelle des Schnitts
  assert.equal((await api(`auftrag/${video.id}/vorschau`, { methode: "POST", json: { zeit: 1.2 } })).headers.get("content-type"), "image/jpeg");
  // Clip entfernen
  const ohne = await (await api(`auftrag/${video.id}/clip/c2/entfernen`, { methode: "POST" })).json();
  assert.deepEqual(ohne.schnitt, [{ clip: "c1", von: 0, bis: 0.5 }]);
  assert.equal((await api(`auftrag/${video.id}/clip/c1/entfernen`, { methode: "POST" })).status, 400);

  // Ungültige Uploads
  const leer = await api("hochladen?name=x.jpg", { methode: "POST", body: Buffer.from("kein bild"), typ: "image/jpeg" });
  assert.equal(leer.status, 400);
});
