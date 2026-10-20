import { test } from "node:test";
import assert from "node:assert/strict";
import { schnittPruefen, schnittDauer, teilAnfaenge, imClip, schnittCues, cuesZurueck, cuesPruefen } from "../src/schnitt.mjs";

const CLIPS = [{ id: "c1", dauer: 10 }, { id: "c2", dauer: 5 }];
// c1 2–6, dann c2 0–3, dann c1 8–10 → 4 + 3 + 2 = 9 s
const SCHNITT = [{ clip: "c1", von: 2, bis: 6 }, { clip: "c2", von: 0, bis: 3 }, { clip: "c1", von: 8, bis: 10 }];

test("Schnitt prüfen: unbekannte Clips raus, Zeiten begrenzt, zu kurze Teile weg", () => {
  assert.deepEqual(schnittPruefen([
    { clip: "c1", von: -3, bis: 4 }, { clip: "c9", von: 0, bis: 1 }, { clip: "c2", von: 2, bis: 99 }, { clip: "c1", von: 5, bis: 5.05 }, null, "x",
  ], CLIPS), [{ clip: "c1", von: 0, bis: 4 }, { clip: "c2", von: 2, bis: 5 }]);
  assert.throws(() => schnittPruefen([], CLIPS), /leer/);
  assert.throws(() => schnittPruefen("kaputt", CLIPS), /fehlt/);
  assert.equal(schnittPruefen(Array.from({ length: 500 }, () => ({ clip: "c1", von: 0, bis: 1 })), CLIPS).length, 200);
});

test("Zeit im fertigen Video ↔ Zeit im Clip", () => {
  assert.equal(schnittDauer(SCHNITT), 9);
  assert.deepEqual(teilAnfaenge(SCHNITT), [0, 4, 7]);
  assert.deepEqual(imClip(SCHNITT, 0), { index: 0, clip: "c1", t: 2 });
  assert.deepEqual(imClip(SCHNITT, 5), { index: 1, clip: "c2", t: 1 });
  assert.deepEqual(imClip(SCHNITT, 8.5), { index: 2, clip: "c1", t: 9.5 });
  assert.deepEqual(imClip(SCHNITT, 99), { index: 2, clip: "c1", t: 10 });
});

test("Untertitel folgen dem Schnitt", () => {
  const cues = [
    { clip: "c1", start: 1000, end: 3000, text: "halb weg" }, // 2–3 s bleibt → 0–1 s
    { clip: "c1", start: 6500, end: 7500, text: "ganz weg" },
    { clip: "c2", start: 500, end: 1500, text: "zweiter Clip" }, // → 4,5–5,5 s
    { clip: "c1", start: 9000, end: 9500, text: "am Ende" }, // → 8–8,5 s
  ];
  assert.deepEqual(schnittCues(cues, SCHNITT), [
    { start: 0, end: 1000, text: "halb weg", index: 0 },
    { start: 4500, end: 5500, text: "zweiter Clip", index: 2 },
    { start: 8000, end: 8500, text: "am Ende", index: 3 },
  ]);
  // Ein Clip zweimal im Schnitt: derselbe Untertitel erscheint zweimal
  assert.equal(schnittCues([{ clip: "c2", start: 0, end: 1000, text: "x" }], [{ clip: "c2", von: 0, bis: 2 }, { clip: "c2", von: 0, bis: 2 }]).length, 2);
});

test("SRT des fertigen Videos zurück in Clip-Zeit", () => {
  const zurueck = cuesZurueck([{ start: 4500, end: 5500, text: "a" }, { start: 6500, end: 8500, text: "über den Schnitt" }], SCHNITT);
  assert.deepEqual(zurueck, [
    { clip: "c2", start: 500, end: 1500, text: "a" },
    { clip: "c2", start: 2500, end: 3000, text: "über den Schnitt" }, // endet am Ende seines Teils
  ]);
  // Hin und zurück bleibt gleich
  const aus = schnittCues(zurueck, SCHNITT);
  assert.deepEqual(aus.map((c) => [c.start, c.end]), [[4500, 5500], [6500, 7000]]);
});

test("Untertitel aus dem Browser prüfen", () => {
  assert.deepEqual(cuesPruefen([
    { clip: "c1", start: -5, end: 900, text: "  Hallo   Welt " }, { clip: "c9", start: 0, end: 900, text: "x" },
    { clip: "c2", start: 0, end: 99999, text: "lang" }, { clip: "c1", start: 0, end: 50, text: "kurz" }, { clip: "c1", start: 0, end: 900, text: "" },
  ], CLIPS), [{ clip: "c1", start: 0, end: 900, text: "Hallo Welt" }, { clip: "c2", start: 0, end: 5000, text: "lang" }]);
});
