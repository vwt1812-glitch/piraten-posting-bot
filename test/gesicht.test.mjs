import { test } from "node:test";
import assert from "node:assert/strict";
import { lageWaehlen, gesichtSuchen, untertitelBereich } from "../src/gesicht.mjs";

const MASSE = { breite: 1080, hoehe: 1920 };
const LAYOUT = { position: 0.35, zeilen: 1, logo: "assets/logos/quer-hell.png" };
// Gesichter, wie gesicht.py sie liefert (Anteile der Bildgröße), 12 Probebilder
const funde = (y, h, anzahl = 12) => ({
  bilder: 12,
  gesichter: Array.from({ length: anzahl }, (_, i) => ({ t: i, x: 0.3, y: y + (i % 3) * 0.01, w: 0.4, h })),
});

test("Untertitel-Bereich: einzeilig unten über Name und Caption der Apps", () => {
  const b = untertitelBereich("unten", { masse: MASSE, layout: LAYOUT });
  assert.equal(b.unten, 0.65);
  assert.ok(b.oben > 0.6 && b.oben < 0.62);
  assert.equal(untertitelBereich("oben", { masse: MASSE, layout: LAYOUT }).unten, 1 - 0.62);
});

test("Gesicht oben im Bild (wie beim Cutter): Untertitel bleiben unten", () => {
  assert.deepEqual(lageWaehlen(funde(0.24, 0.2), { masse: MASSE, layout: LAYOUT }), { lage: "unten", frei: true, hinweise: [] });
});

test("Selfie mit Gesicht tief im Bild: Untertitel kommen nach oben", () => {
  // gemessen in einem Selfie-Video: Gesicht von 42 % bis 71 % der Höhe
  const wahl = lageWaehlen(funde(0.42, 0.27), { masse: MASSE, layout: LAYOUT });
  assert.equal(wahl.lage, "oben");
  assert.equal(wahl.frei, true);
});

test("Gesicht füllt das Bild: geringste Überdeckung und ein Tipp", () => {
  const wahl = lageWaehlen(funde(0.2, 0.6), { masse: MASSE, layout: LAYOUT });
  assert.equal(wahl.frei, false);
  assert.match(wahl.hinweise.join(" "), /Schritt zurück/);
});

test("Kopf im Logo: Tipp fürs nächste Mal", () => {
  const wahl = lageWaehlen(funde(0.12, 0.2), { masse: MASSE, layout: LAYOUT });
  assert.match(wahl.hinweise.join(" "), /bis ins Logo/);
  assert.deepEqual(lageWaehlen(funde(0.12, 0.2), { masse: MASSE, layout: { ...LAYOUT, logo: null } }).hinweise, []);
});

test("Nichts ändern ohne verlässlichen Fund oder im Querformat", () => {
  const standard = { lage: "unten", frei: true, hinweise: [] };
  assert.deepEqual(lageWaehlen({ bilder: 12, gesichter: [] }, { masse: MASSE, layout: LAYOUT }), standard);
  assert.deepEqual(lageWaehlen(funde(0.42, 0.27, 3), { masse: MASSE, layout: LAYOUT }), standard); // nur 3 von 12
  assert.deepEqual(lageWaehlen(funde(0.42, 0.27), { masse: { breite: 1920, hoehe: 1080 }, layout: LAYOUT }), standard);
  assert.deepEqual(lageWaehlen(null, { masse: MASSE, layout: LAYOUT }), standard);
});

test("Ohne OpenCV bleibt die Gesichtssuche einfach aus", async () => {
  assert.equal(await gesichtSuchen("egal.mp4", { python: "/gibt/es/nicht/python" }), null);
  assert.equal(await gesichtSuchen("egal.mp4", { python: "" }), null);
});

// ---------- Neu im Posting-Bot: Zielformat und automatische Lage ----------
import { aufZielflaeche, lageFuer } from "../src/gesicht.mjs";

test("Gesicht aufs Zielformat umrechnen: Rand und Zuschnitt", () => {
  const g = { x: 0.5, y: 0.5, w: 0.1, h: 0.2 };
  const quer = { breite: 1920, hoehe: 1080 };
  const hoch = { breite: 1080, hoehe: 1920 };
  // gleiches Format: unverändert
  assert.deepEqual(aufZielflaeche(g, { breite: 720, hoehe: 1280 }, hoch), g);
  // 16:9 mit Rand in 9:16: das Bild liegt als Streifen in der Mitte (Höhe 607,5 von 1920)
  const rand = aufZielflaeche({ x: 0, y: 0, w: 1, h: 1 }, quer, hoch, "rand");
  assert.ok(Math.abs(rand.y - (1920 - 607.5) / 2 / 1920) < 1e-9);
  assert.ok(Math.abs(rand.h - 607.5 / 1920) < 1e-9);
  assert.equal(rand.w, 1);
  // Zuschnitt: volle Höhe, seitlich beschnitten
  const zu = aufZielflaeche(g, quer, hoch, "zuschneiden");
  assert.equal(zu.y, 0.5);
  assert.equal(zu.h, 0.2);
  assert.ok(zu.w > g.w);
});

test("Lage „auto“ nutzt die Gesichter im Zielformat, sonst gilt die gewählte", () => {
  const hoch = { breite: 1080, hoehe: 1920 };
  const funde = { bilder: 12, gesichter: Array.from({ length: 12 }, () => ({ x: 0.3, y: 0.5, w: 0.4, h: 0.2 })) };
  const e = { untertitelLage: "auto", anpassen: "rand", logo: "common/piraten", logoPosition: "oben-links" };
  assert.equal(lageFuer({ e, quellen: [{ funde, quelle: hoch }], masse: hoch }).lage, "oben");
  assert.equal(lageFuer({ e, quellen: [{ funde, quelle: hoch }], masse: hoch }).automatisch, true);
  // Quer mit Rand: das Gesicht landet in der Mitte des 9:16-Bildes, unten bleibt frei
  assert.equal(lageFuer({ e, quellen: [{ funde: { ...funde, gesichter: funde.gesichter.map((g) => ({ ...g, y: 0.2 })) }, quelle: { breite: 1920, hoehe: 1080 } }], masse: hoch }).lage, "unten");
  assert.deepEqual(lageFuer({ e: { ...e, untertitelLage: "mitte" }, quellen: [{ funde, quelle: hoch }], masse: hoch }), { lage: "mitte", automatisch: false, hinweise: [] });
  assert.equal(lageFuer({ e, quellen: [{ funde: null, quelle: hoch }], masse: hoch }).lage, "unten");
});
