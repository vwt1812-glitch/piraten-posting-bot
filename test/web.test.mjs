import { test } from "node:test";
import assert from "node:assert/strict";
import { sitzungErstellen, sitzungLesen, bereinigen } from "../src/web.mjs";
import { ladePpicng } from "../src/ppicng.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);

test("Sitzung: signiert, läuft ab, lässt sich nicht fälschen", () => {
  const s = sitzungErstellen("geheim", "@anja:piratenpartei.de", 1000);
  assert.equal(sitzungLesen("geheim", s, 2000), "@anja:piratenpartei.de");
  assert.equal(sitzungLesen("anders", s, 2000), null);
  assert.equal(sitzungLesen("geheim", s, 1000 + 15 * 864e5), null);
  const [inhalt, sig] = s.split(".");
  const falsch = Buffer.from(JSON.stringify({ n: "@chef:piratenpartei.de", b: 9e15 })).toString("base64url");
  assert.equal(sitzungLesen("geheim", `${falsch}.${sig}`, 2000), null);
  assert.equal(sitzungLesen("geheim", inhalt, 2000), null);
  assert.equal(sitzungLesen("geheim", undefined), null);
});

test("Einstellungen aus dem Browser: nur Bekanntes, keine Dateipfade", () => {
  const alt = { design: "weiss-schwarz-orange", logo: "common/piraten", format: "9:16", bild: "/daten/foto.png", titelkarte: { bild: "/daten/karte.png" }, abspann: null, untertitel: true, claim: "" };
  const e = bereinigen({
    design: "pink", logo: "laender/bayern", format: "../../etc", bild: "/etc/passwd", claim: "x".repeat(1000), untertitel: "ja",
    titelkarte: { art: "bild", bild: "/etc/shadow" }, abspann: { art: "text", claim: "piraten.de", bild: "/etc/passwd" }, boese: 1,
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
  assert.equal(bereinigen({ logo: "gibt/esnicht" }, alt, ppicng).logo, "common/piraten");
  assert.equal(bereinigen({ titelkarte: null }, alt, ppicng).titelkarte, null);
});
