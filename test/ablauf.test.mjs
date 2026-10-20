// Ende-zu-Ende: Der ganze Bot läuft gegen nachgebaute Server für Telegram, Matrix und Postiz.
// Telegram: Video schicken → Vorschau mit Menü → Design ändern → neu bauen → posten über Postiz.
// Matrix: Einladung annehmen → !sharepic → Menü mit Reaktionen → Reaktion antippen und Zahl schicken.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { Readable } from "node:stream";

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

const TOKEN = "123:abc";
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-ablauf-"));
const anrufe = []; // { dienst, methode, daten }
const telegramUpdates = [];
const matrixEvents = []; // { raum, ev } oder { einladung: raum, von }
let updateId = 0;
let eventNr = 0;

const neu = (dienst, methode, daten = {}) => anrufe.push({ dienst, methode, daten });
const json = (res, wert, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(wert));
};

async function anfrage(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const typ = req.headers["content-type"] ?? "";
  if (typ.startsWith("multipart/form-data")) {
    const r = new Request("http://x", { method: "POST", headers: { "content-type": typ }, body });
    const form = await r.formData();
    const daten = {};
    for (const [k, v] of form) daten[k] = typeof v === "string" ? v : `<datei ${v.name}>`;
    return daten;
  }
  if (typ.includes("json") && body.length) return JSON.parse(body);
  return { bytes: body.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const daten = await anfrage(req);

  // --- Telegram ---
  const tg = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
  if (tg) {
    const methode = tg[2];
    if (methode === "getUpdates") {
      const bis = Date.now() + 500;
      while (!telegramUpdates.length && Date.now() < bis) await new Promise((r) => setTimeout(r, 25));
      return json(res, { ok: true, result: telegramUpdates.splice(0) });
    }
    neu("telegram", methode, daten);
    if (methode === "getMe") return json(res, { ok: true, result: { username: "testbot" } });
    if (methode === "getFile") return json(res, { ok: true, result: { file_path: "videos/quelle.mp4" } });
    return json(res, { ok: true, result: { message_id: anrufe.length } });
  }
  if (url.pathname === `/file/bot${TOKEN}/videos/quelle.mp4`) {
    res.writeHead(200);
    return Readable.from(fs.createReadStream(path.join(ordner, "quelle.mp4"))).pipe(res);
  }

  // --- Postiz ---
  if (url.pathname.startsWith("/api/public/v1/")) {
    const pfad = url.pathname.slice("/api/public/v1".length);
    neu("postiz", `${req.method} ${pfad}`, daten);
    if (pfad === "/integrations") {
      return json(res, [
        { id: "kanal-ig", name: "Instagram KV", identifier: "instagram", disabled: false, customer: { id: "kunde1", name: "KV Test" } },
        { id: "kanal-x", name: "X KV", identifier: "x", disabled: false, customer: { id: "kunde1", name: "KV Test" } },
      ]);
    }
    if (pfad === "/upload") return json(res, { id: "medium1", path: "https://postiz/medium1.mp4" });
    if (pfad === "/posts" && req.method === "POST") return json(res, [{ postId: "post1", integration: "kanal-ig" }]);
    if (pfad.startsWith("/posts")) return json(res, { posts: [] });
    return json(res, {}, 404);
  }

  // --- Matrix ---
  if (url.pathname.startsWith("/_matrix/")) {
    const pfad = url.pathname;
    if (pfad.endsWith("/sync")) {
      if (!url.searchParams.get("since")) return json(res, { next_batch: "s0" });
      const bis = Date.now() + 500;
      while (!matrixEvents.length && Date.now() < bis) await new Promise((r) => setTimeout(r, 25));
      const rooms = { join: {}, invite: {} };
      for (const m of matrixEvents.splice(0)) {
        if (m.einladung) {
          rooms.invite[m.einladung] = { invite_state: { events: [{ type: "m.room.member", state_key: "@bot:test", sender: m.von, content: { membership: "invite" } }] } };
        } else {
          rooms.join[m.raum] ??= { timeline: { events: [] } };
          rooms.join[m.raum].timeline.events.push({ event_id: `$u${++eventNr}`, ...m.ev });
        }
      }
      return json(res, { next_batch: `s${++eventNr}`, rooms });
    }
    neu("matrix", `${req.method} ${pfad.replace(/\/\d+-\d+$/, "")}`, daten);
    if (pfad === "/_matrix/client/v1/media/download/test/video1") {
      if (req.headers.authorization !== "Bearer geheim") return json(res, {}, 401);
      res.writeHead(200);
      return fs.createReadStream(path.join(ordner, "quelle.mp4")).pipe(res);
    }
    if (pfad.endsWith("/account/whoami")) return json(res, { user_id: "@bot:test" });
    if (pfad.endsWith("/media/config")) return json(res, { "m.upload.size": 100 * 1024 * 1024 });
    if (pfad.includes("/upload")) return json(res, { content_uri: `mxc://test/m${anrufe.length}` });
    if (pfad.includes("/send/")) return json(res, { event_id: `$bot${anrufe.length}` });
    return json(res, {});
  }
  json(res, {}, 404);
});

let bot;
let ausgabe = "";

async function warteAuf(bedingung, beschreibung, ms = 60000) {
  const bis = Date.now() + ms;
  for (;;) {
    const treffer = bedingung();
    if (treffer) return treffer;
    if (Date.now() > bis) throw new Error(`Zeitüberschreitung: ${beschreibung}\nBot-Ausgabe:\n${ausgabe.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const ab = (i, dienst, methode) => anrufe.slice(i).find((a) => a.dienst === dienst && (typeof methode === "string" ? a.methode === methode : methode.test(a.methode)));

after(() => {
  bot?.kill();
  server.close();
});

test("Ablauf über Telegram und Matrix", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 240000 }, async () => {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(ordner, "quelle.mp4")]);
  await new Promise((r) => server.listen(0, r));
  const basis = `http://localhost:${server.address().port}`;
  bot = spawn(process.execPath, ["src/bot.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_URL: basis.replace("localhost", "127.0.0.1"), // nicht api.telegram.org → kein 20-MB-Limit
      TELEGRAM_ERLAUBT: "42",
      MATRIX_URL: basis,
      MATRIX_TOKEN: "geheim",
      MATRIX_ERLAUBT: "*:test",
      POSTIZ_URL: basis,
      POSTIZ_API_KEY: "key",
      POSTIZ_KUNDE: "KV Test",
      DATEN_DIR: path.join(ordner, "daten"),
      CHATS: path.join(ordner, "gibtsnicht.json"),
      VIDEO_PRESET: "ultrafast",
      VIDEO_FORMAT: "9:16",
      TITELKARTE_DAUER: "1",
      ABSPANN_DAUER: "1",
    },
  });
  bot.stdout.on("data", (d) => (ausgabe += d));
  bot.stderr.on("data", (d) => (ausgabe += d));
  await warteAuf(() => /ppicng: \d+ Logos/.test(ausgabe), "Bot startet");

  // ---------- Telegram ----------
  const von = { id: 42, first_name: "Anja" };
  const chat = { id: 42, type: "private" };
  const tgNachricht = (m) => telegramUpdates.push({ update_id: ++updateId, message: { message_id: updateId, from: von, chat, ...m } });
  const tgKnopf = (daten) => telegramUpdates.push({ update_id: ++updateId, callback_query: { id: `q${updateId}`, from: von, data: daten, message: { message_id: 1, chat } } });

  let i = anrufe.length;
  tgNachricht({ text: "/start" });
  const hilfe = await warteAuf(() => ab(i, "telegram", "sendMessage"), "Hilfe");
  assert.match(hilfe.daten.text, /Piraten-Posting-Bot/);

  // Fremde bekommen ihre ID genannt
  i = anrufe.length;
  telegramUpdates.push({ update_id: ++updateId, message: { message_id: 99, from: { id: 7, first_name: "Fremd" }, chat: { id: 7, type: "private" }, text: "hallo" } });
  assert.match((await warteAuf(() => ab(i, "telegram", "sendMessage"), "Abweisung")).daten.text, /nicht freigeschaltet.*7/s);

  i = anrufe.length;
  tgNachricht({ document: { file_id: "F1", file_name: "quelle.mp4", mime_type: "video/mp4", file_size: 1000 } });
  await warteAuf(() => ab(i, "telegram", "sendVideo"), "Vorschauvideo");
  const menu = await warteAuf(() => anrufe.slice(i).find((a) => a.methode === "sendMessage" && a.daten.reply_markup), "Hauptmenü");
  const knoepfe = menu.daten.reply_markup.inline_keyboard.flat();
  assert.match(menu.daten.text, /Instagram KV, X KV/); // Kanäle des Kunden vorausgewählt
  const daten = (text) => knoepfe.find((k) => k.text.includes(text)).callback_data;
  const id = daten("Gestaltung").split(":")[0];

  i = anrufe.length;
  tgKnopf(`${id}:design`);
  const designMenu = await warteAuf(() => ab(i, "telegram", "editMessageText"), "Designmenü");
  assert.match(JSON.stringify(designMenu.daten.reply_markup), /Lila · Weiß · Orange/);
  tgKnopf(`${id}:d:lila-weiss-orange`);
  tgKnopf(`${id}:fertig`);
  await warteAuf(() => ab(i, "telegram", "sendVideo"), "neu gebautes Video");
  await warteAuf(() => anrufe.slice(i).find((a) => a.methode === "sendMessage" && /Lila/.test(a.daten.text ?? "")), "Menü nach Neubau");

  i = anrufe.length;
  tgKnopf(`${id}:jetzt`);
  const frage = await warteAuf(() => ab(i, "telegram", "editMessageText"), "Rückfrage");
  assert.match(frage.daten.text, /Wirklich jetzt/);
  tgKnopf(`${id}:ja:jetzt`);
  const post = await warteAuf(() => ab(i, "postiz", "POST /posts"), "Postiz-Beitrag");
  assert.equal(post.daten.type, "now");
  assert.deepEqual(post.daten.posts.map((p) => p.integration.id), ["kanal-ig", "kanal-x"]);
  assert.equal(post.daten.posts[0].value[0].image[0].id, "medium1");
  assert.ok(ab(i, "postiz", "POST /upload"));
  await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "telegram" && /Gepostet auf/.test(a.daten.text ?? "")), "Bestätigung");

  // Nach dem Posten nur noch die Datei
  i = anrufe.length;
  tgKnopf(`${id}:datei`);
  assert.match((await warteAuf(() => ab(i, "telegram", "sendDocument"), "Datei")).daten.document, /piraten-video-/);

  // ---------- Matrix ----------
  i = anrufe.length;
  matrixEvents.push({ einladung: "!raum:test", von: "@anja:test" });
  await warteAuf(() => ab(i, "matrix", /^POST .*\/join\//), "Raum betreten");

  i = anrufe.length;
  matrixEvents.push({ raum: "!raum:test", ev: { type: "m.room.message", sender: "@anja:test", content: { msgtype: "m.text", body: "!sharepic Barrieren abbauen!\nFür alle." } } });
  await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && a.daten.msgtype === "m.image"), "Sharepic-Vorschau");
  const mxMenu = await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && /1️⃣/.test(a.daten.body ?? "")), "Menü in Matrix");
  assert.match(mxMenu.daten.body, /Sharepic fertig/);
  const menuId = `$bot${anrufe.indexOf(mxMenu) + 1}`;
  await warteAuf(() => anrufe.slice(i).filter((a) => a.daten["m.relates_to"]?.rel_type === "m.annotation").length >= 5, "Reaktionen unter dem Menü");

  // Reaktion auf die Zeile „🎨 Gestaltung“
  const key = mxMenu.daten.body.split("\n").find((z) => z.includes("Gestaltung")).split(" ")[0];
  i = anrufe.length;
  matrixEvents.push({ raum: "!raum:test", ev: { type: "m.reaction", sender: "@anja:test", content: { "m.relates_to": { rel_type: "m.annotation", event_id: menuId, key } } } });
  const gestaltung = await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && /Gestaltung/.test(a.daten.body ?? "") && /Claim ändern/.test(a.daten.body)), "Gestaltungsmenü");
  assert.ok(ab(i, "matrix", /\/redact\//), "altes Menü wird gelöscht");

  // Zahl schicken statt Reaktion: „1“ = Design
  i = anrufe.length;
  matrixEvents.push({ raum: "!raum:test", ev: { type: "m.room.message", sender: "@anja:test", content: { msgtype: "m.text", body: "1" } } });
  await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && /Farbschemata/.test(a.daten.body ?? "")), "Designmenü per Zahl");
  assert.ok(gestaltung);

  // Video über Matrix, Bildunterschrift wird zur Notiz
  i = anrufe.length;
  matrixEvents.push({ raum: "!raum:test", ev: { type: "m.room.message", sender: "@anja:test", content: { msgtype: "m.video", body: "Rede im Stadtrat", filename: "rede.mp4", url: "mxc://test/video1", info: { mimetype: "video/mp4", size: 1000 } } } });
  const mxVideo = await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && a.daten.msgtype === "m.video"), "Video-Vorschau in Matrix", 120000);
  assert.equal(mxVideo.daten.info.w, 1080);
  assert.equal(mxVideo.daten.info.h, 1920);
  await warteAuf(() => anrufe.slice(i).find((a) => a.dienst === "matrix" && /Video fertig/.test(a.daten.body ?? "")), "Menü zum Matrix-Video");
});
