import { test } from "node:test";
import assert from "node:assert/strict";
import { ladePpicng } from "../src/ppicng.mjs";
import * as M from "../src/menues.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
const kanaele = [{ id: "cm0abcdefghijklmnopqrstuv", name: "Instagram", identifier: "instagram" }];
const ctx = { ppicng, postiz: true, ki: true, whisper: true, kanaele, kanaeleAuswahl: kanaele, kunden: [{ id: "cm0kundekundekundekundekun", name: "KV" }], standardLogo: "common/piraten", standardBauchbinde: { name: "Anja", funktion: "" } };
const auftrag = (art) => ({
  id: "a1b2c3d4", art, caption: "Text <mit> Zeichen", kanaele: [kanaele[0].id], kunde: null, hatUntertitel: true,
  e: { design: "weiss-schwarz-orange", logo: "international/enneperuhrsignet", format: "9:16", anpassen: "rand", untertitel: true, untertitelStil: "box", untertitelLage: "unten", bauchbinde: { name: "Anja" }, bauchbindeAn: true, titelkarte: null, abspannAn: false, abspannText: "piratenpartei.de", sharepicFormat: "1:1", claim: "C", text: "", bild: "x.png", bildStil: "geteilt" },
});

const alleMenues = (a) => [
  M.hauptMenu(a, ctx), M.gestaltungMenu(a, ctx), M.designMenu(a), M.logoMenu(a, ctx), M.logoMenu(a, ctx, ppicng.logos.slice(0, 8), "x"),
  M.formatMenu(a), M.untertitelMenu(a, ctx), M.bauchbindeMenu(a, ctx), M.karteMenu(a, ctx, "titelkarte"), M.karteMenu(a, ctx, "abspann"),
  M.bildstilMenu(a), M.kanaeleMenu(a, ctx), M.kundeMenu(a, ctx), M.planenMenu(a), M.bestaetigenMenu(a, ctx, new Date()),
];

test("Knopfdaten passen in die 64 Bytes von Telegram", () => {
  for (const art of ["video", "sharepic"]) {
    for (const m of alleMenues(auftrag(art))) {
      for (const k of m.knoepfe.flat()) {
        assert.ok(Buffer.byteLength(k.daten) <= 64, k.daten);
        assert.ok(k.daten.startsWith("a1b2c3d4:"), k.daten);
      }
    }
  }
  // Längste Logo-ID
  const lang = ppicng.logos.reduce((a, l) => (l.id.length > a.length ? l.id : a), "");
  assert.ok(Buffer.byteLength(`a1b2c3d4:l:${lang}`) <= 64, lang);
});

test("Haupt- und Gestaltungsmenü kommen mit 10 Reaktionen (Matrix) aus", () => {
  for (const art of ["video", "sharepic"]) {
    const a = auftrag(art);
    assert.ok(M.hauptMenu(a, ctx).knoepfe.flat().length <= 10);
    assert.ok(M.gestaltungMenu(a, ctx).knoepfe.flat().length <= 10);
  }
});

test("Texte sind HTML-sicher", () => {
  assert.match(M.hauptMenu(auftrag("video"), ctx).text, /Text &lt;mit&gt; Zeichen/);
  assert.match(M.hilfe({ plattform: "matrix" }), /!sharepic/);
  assert.match(M.hilfe({ plattform: "telegram" }), /\/sharepic/);
});
