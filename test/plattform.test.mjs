import { test } from "node:test";
import assert from "node:assert/strict";
import { ereignisAus as telegramEreignis, tastatur } from "../src/plattform/telegram.mjs";
import { ereignisAus as matrixEreignis, htmlZuText, inhalt, istErlaubt, ohneZitat, menuListe, ZIFFERN } from "../src/plattform/matrix.mjs";

test("Telegram: Video als Datei, Foto, Text und Knopf", () => {
  const von = { id: 7, first_name: "Anja" };
  const chat = { id: -100, type: "supergroup" };
  const doc = telegramEreignis({ message: { message_id: 1, from: von, chat, document: { file_id: "F", file_name: "a.mov", mime_type: "video/quicktime", file_size: 9 } } });
  assert.deepEqual(doc.medium, { art: "video", ref: "F", name: "a.mov", groesse: 9, mime: "video/quicktime" });
  assert.equal(doc.chat, "-100");
  assert.equal(doc.gruppe, true);
  const foto = telegramEreignis({ message: { message_id: 2, from: von, chat, caption: "Claim", photo: [{ file_id: "klein" }, { file_id: "gross" }] } });
  assert.equal(foto.medium.ref, "gross");
  assert.equal(foto.text, "Claim");
  const knopf = telegramEreignis({ callback_query: { id: "q", from: von, data: "ab:menu", message: { message_id: 3, chat } } });
  assert.equal(knopf.typ, "knopf");
  assert.equal(knopf.daten, "ab:menu");
  assert.equal(telegramEreignis({ message: { message_id: 4, from: von, chat, sticker: {} } }), null);
  assert.deepEqual(tastatur([[{ text: "A", daten: "x:a" }]]), { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "x:a" }]] } });
});

test("Matrix: Menü als nummerierte Liste mit HTML", () => {
  const c = inhalt("<b>Hallo</b> &amp; so\nzweite Zeile", [[{ text: "Eins", daten: "a:1" }, { text: "Zwei", daten: "a:2" }], [{ text: "<Drei>", daten: "a:3" }]]);
  assert.equal(c.body, "Hallo & so\nzweite Zeile\n\n1️⃣ Eins\n2️⃣ Zwei\n3️⃣ <Drei>");
  assert.match(c.formatted_body, /<b>Hallo<\/b> &amp; so<br>zweite Zeile<br><br>1️⃣ Eins<br>2️⃣ Zwei<br>3️⃣ &lt;Drei&gt;/);
  assert.equal(menuListe(Array.from({ length: 12 }, (_, i) => [{ text: String(i), daten: String(i) }]))[11].zeichen, "12.");
  assert.equal(htmlZuText('<a href="https://x.de">Link</a> <code>a&lt;b</code>'), "Link (https://x.de) a<b");
});

test("Matrix: Freigabe für Personen, Räume und ganze Server", () => {
  const liste = ["@anja:piratenpartei.de", "!raum:matrix.org", "*:piraten-bayern.de"];
  assert.ok(istErlaubt(liste, "@anja:piratenpartei.de", "!x:y"));
  assert.ok(istErlaubt(liste, "@fremd:matrix.org", "!raum:matrix.org"));
  assert.ok(istErlaubt(liste, "@bob:piraten-bayern.de", "!x:y"));
  assert.ok(!istErlaubt(liste, "@bob:evil-piraten-bayern.de", "!x:y"));
  assert.ok(!istErlaubt(liste, "@eve:matrix.org", "!x:y"));
});

test("Matrix: Ereignisse aus der Timeline", () => {
  const menues = new Map([["$menu", { daten: ["a:jetzt", "a:planen"] }]]);
  const letztes = new Map([["!r", "$menu"]]);
  const z = { ich: "@bot:p.de", menues, letztes };
  const msg = (content, extra = {}) => ({ type: "m.room.message", sender: "@anja:p.de", event_id: "$e", content, ...extra });

  assert.equal(matrixEreignis(msg({ msgtype: "m.text", body: "hi" }, { sender: "@bot:p.de" }), "!r", z), null);
  const zahl = matrixEreignis(msg({ msgtype: "m.text", body: "2" }), "!r", z);
  assert.equal(zahl.auswahl, "a:planen");
  assert.equal(matrixEreignis(msg({ msgtype: "m.text", body: "7" }), "!r", z).auswahl, undefined);

  const reaktion = matrixEreignis({ type: "m.reaction", sender: "@anja:p.de", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$menu", key: ZIFFERN[0] } } }, "!r", z);
  assert.deepEqual([reaktion.typ, reaktion.daten, reaktion.nachricht], ["knopf", "a:jetzt", "$menu"]);
  assert.equal(matrixEreignis({ type: "m.reaction", sender: "@anja:p.de", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$menu", key: "👍" } } }, "!r", z), null);

  const video = matrixEreignis(msg({ msgtype: "m.video", body: "Mein Claim", filename: "v.mp4", url: "mxc://p.de/abc", info: { mimetype: "video/mp4", size: 5 } }), "!r", z);
  assert.deepEqual([video.typ, video.medium.art, video.medium.ref, video.text], ["medium", "video", "mxc://p.de/abc", "Mein Claim"]);
  const datei = matrixEreignis(msg({ msgtype: "m.file", body: "clip.mov", url: "mxc://p.de/d", info: { mimetype: "video/quicktime" } }), "!r", z);
  assert.equal(datei.medium.art, "video");
  assert.equal(datei.text, "");
  assert.equal(matrixEreignis(msg({ msgtype: "m.image", body: "x.jpg", file: { url: "mxc://p.de/enc" } }), "!r", z).typ, "verschluesselt");
  assert.equal(matrixEreignis({ type: "m.room.encrypted", sender: "@anja:p.de", content: {} }, "!r", z).typ, "verschluesselt");
  // Bearbeitungen ignorieren
  assert.equal(matrixEreignis(msg({ msgtype: "m.text", body: "* neu", "m.relates_to": { rel_type: "m.replace" } }), "!r", z), null);
  assert.equal(ohneZitat("> <@a:b> alt\n> zeile\n\nneu"), "neu");
});
