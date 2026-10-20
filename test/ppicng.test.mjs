import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ladePpicng, logoNachId, sucheLogos, logoDatei, farbschema, istHell, FARBSCHEMATA } from "../src/ppicng.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);

test("ppicng: Logos und Schriften aus dem Submodul", () => {
  assert.ok(ppicng.logos.length > 50);
  for (const datei of Object.values(ppicng.schriften)) assert.ok(fs.existsSync(datei), datei);
  assert.match(ppicng.schriften.claim, /PoliticsHead\.otf$/);
  const piraten = logoNachId(ppicng, "common/piraten");
  assert.equal(piraten.titel, "Piratenpartei");
  for (const l of ppicng.logos) assert.ok(fs.existsSync(l.standard), l.standard);
});

test("ppicng: Logovariante nach Schriftfarbe wie im Original", () => {
  const piraten = logoNachId(ppicng, "common/piraten");
  assert.match(logoDatei(piraten, "#ffffff"), /piraten_light\.png$/); // helle Schrift auf dunklem Grund
  assert.match(logoDatei(piraten, "#000000"), /piraten_dark\.png$/);
  const signet = logoNachId(ppicng, "common/signet");
  assert.match(logoDatei(signet, "#ffffff"), /signet\.png$/); // ohne Varianten: Standard
});

test("ppicng: Logos suchen", () => {
  assert.equal(sucheLogos(ppicng, "Bayern")[0].id, "laender/bayern");
  assert.equal(sucheLogos(ppicng, "göppingen")[0].id, "regional/goeppingen");
  assert.ok(sucheLogos(ppicng, "jupi").length >= 5);
  assert.deepEqual(sucheLogos(ppicng, "gibtsnicht"), []);
  assert.deepEqual(sucheLogos(ppicng, "  "), []);
});

test("Farbschemata wie ppicng classic", () => {
  assert.equal(farbschema("weiss-schwarz-orange").linie, "#ff8800");
  assert.equal(farbschema("purple-white-orange").hintergrund, "#652480");
  assert.throws(() => farbschema("pink"), /Unbekanntes Design/);
  assert.equal(Object.keys(FARBSCHEMATA).length, 5);
  assert.ok(istHell("#ffffff") && !istHell("#000000") && !istHell("#652480"));
});
