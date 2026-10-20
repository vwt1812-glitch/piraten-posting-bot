import { test } from "node:test";
import assert from "node:assert/strict";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { ladePpicng, logoNachId, farbschema } from "../src/ppicng.mjs";
import { schriftenAnmelden, umbrechenAufBreite, einpassen, blockHoehe, sharepic, logoPlakette, bauchbinde, svgOhneKlassen, fotoMitLogo, eigenesBild, raender, logoLage } from "../src/grafik.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
schriftenAnmelden(ppicng);
const piraten = logoNachId(ppicng, "common/piraten");

// Jede Ziffer/jeder Buchstabe gleich breit: 0,5 × Schriftgröße
const messen = (t, g) => t.length * g * 0.5;

test("Umbruch an Wortgrenzen, Zeilenumbrüche bleiben", () => {
  const z = umbrechenAufBreite("eins zwei drei\nvier", 50, (t) => messen(t, 10));
  assert.deepEqual(z.map((x) => x.text), ["eins zwei", "drei", "vier"]);
});

test("Einpassen: größte Schrift, die passt – samt Linie", () => {
  const l = einpassen("Barrieren abbauen!", { breite: 500, hoehe: 400, zeilenhoehe: 0.9, linie: true, messen });
  assert.ok(l.zeilen.every((z) => z.breite <= 500));
  assert.ok(l.hoehe <= 400);
  const groesser = einpassen("Barrieren abbauen!", { breite: 500, hoehe: 400, zeilenhoehe: 0.9, linie: true, messen: (t, g) => messen(t, g + 1) });
  assert.ok(groesser.groesse <= l.groesse);
  assert.equal(blockHoehe(1, 100, 0.9), 100);
  assert.equal(blockHoehe(3, 100, 0.9), 280);
  // maxGroesse begrenzt
  assert.ok(einpassen("a", { breite: 1000, hoehe: 1000, maxGroesse: 50, messen }).groesse <= 50);
});

async function pixel(png, x, y) {
  const bild = await loadImage(png);
  const c = createCanvas(bild.width, bild.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(bild, 0, 0);
  return { breite: bild.width, hoehe: bild.height, farbe: [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)] };
}

test("Sharepic im classic-Layout: Größe, Hintergrund, orange Linie", async () => {
  const png = await sharepic({ breite: 1080, hoehe: 1350, schema: farbschema("lila-weiss-orange"), claim: "Freies WLAN", text: "für alle Schulen", logo: piraten });
  const p = await pixel(png, 5, 5);
  assert.equal(p.breite, 1080);
  assert.equal(p.hoehe, 1350);
  assert.deepEqual(p.farbe, [0x65, 0x24, 0x80]);
  // Irgendwo in der linken Spalte liegt die orange Linie unter dem Claim
  const bild = await loadImage(png);
  const c = createCanvas(bild.width, bild.height);
  c.getContext("2d").drawImage(bild, 0, 0);
  const spalte = c.getContext("2d").getImageData(80, 0, 1, 1350).data;
  let orange = false;
  for (let y = 0; y < 1350; y++) if (spalte[y * 4] === 0xff && spalte[y * 4 + 1] === 0x88 && spalte[y * 4 + 2] === 0) orange = true;
  assert.ok(orange);
});

test("Logo-Plakette und Bauchbinde haben gerade Maße", async () => {
  const p = await logoPlakette({ logo: piraten, schema: farbschema("weiss-schwarz-orange"), logoBreite: 389 });
  assert.equal(p.breite % 2, 0);
  assert.equal(p.hoehe % 2, 0);
  assert.equal((await pixel(p.png, 1, p.hoehe - 1)).farbe.join(), "255,136,0");
  const b = await bauchbinde({ name: "Ein sehr langer Name, der nicht passt", funktion: "Funktion", schema: farbschema("schwarz-weiss-orange"), einheit: 80, maxBreite: 600 });
  assert.ok(b.breite <= 600);
  assert.equal(b.breite % 2, 0);
});

test("SVG mit Stylesheet wird zu Inline-Styles", () => {
  const svg = `<svg><style>.st0{fill:#F18616;}.st1{display:none}</style><path class="st0" d="M0"/><rect class="st1" style="opacity:1"/></svg>`;
  const aus = svgOhneKlassen(svg);
  assert.ok(!aus.includes("<style"));
  assert.match(aus, /<path style="fill:#F18616;" d="M0"\/>/);
  assert.match(aus, /<rect style="display:none;opacity:1"\/>/);
});

test("SVG-Logos aus ppicng werden nicht schwarz gemalt", async () => {
  const humanisten = logoNachId(ppicng, "lists/piratenxhumanisten");
  const png = await sharepic({ breite: 600, hoehe: 600, schema: farbschema("schwarz-weiss-orange"), claim: "Test", logo: humanisten });
  const bild = await loadImage(png);
  const c = createCanvas(600, 600);
  c.getContext("2d").drawImage(bild, 0, 0);
  const unten = c.getContext("2d").getImageData(0, 440, 600, 140).data;
  let hell = 0;
  for (let i = 0; i < unten.length; i += 4) if (unten[i] > 200) hell++;
  assert.ok(hell > 500, `nur ${hell} helle Pixel im Logobereich`);
});

test("Foto mit Logo und eigenes Bild", async () => {
  const foto = new URL("../ppicng/src/designs/gp2024/backgrounds/papagei.png", import.meta.url).pathname;
  const a = await fotoMitLogo({ breite: 1080, hoehe: 1080, bild: foto, logo: piraten, schema: farbschema("weiss-schwarz-orange"), logoBreite: 0.36, position: "oben-links" });
  const { x, y } = logoLage({ masse: { breite: 1080, hoehe: 1080 }, grafik: { breite: 10, hoehe: 10 }, video: false });
  assert.deepEqual((await pixel(a, x + 2, y + 2)).farbe, [255, 255, 255]);
  const b = await eigenesBild({ breite: 1080, hoehe: 1920, bild: foto, schema: farbschema("schwarz-weiss-orange") });
  assert.deepEqual((await pixel(b, 5, 5)).farbe, [0, 0, 0]);
});

test("Ränder: hochkant oben Platz für die App-Leisten", () => {
  assert.deepEqual(raender({ breite: 1080, hoehe: 1920 }), { rand: 54, oben: 269 });
  assert.deepEqual(raender({ breite: 1080, hoehe: 1920 }, false), { rand: 54, oben: 140 });
  assert.deepEqual(raender({ breite: 1920, hoehe: 1080 }), { rand: 54, oben: 54 });
  assert.deepEqual(logoLage({ masse: { breite: 1920, hoehe: 1080 }, grafik: { breite: 100, hoehe: 50 }, position: "unten-rechts" }), { x: 1766, y: 976 });
});
