// Gelöste Tonspur: Rechnen, Ausrichten einer Tonaufnahme am Kamera-Ton, Rendern mit echtem ffmpeg.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tonAusSchnitt, tonspurPruefen, tonCues, cuesZurueckTon, versatzFinden } from "../src/schnitt.mjs";
import { Werkstatt } from "../src/werkstatt.mjs";
import { ladePpicng } from "../src/ppicng.mjs";
import { schriftenAnmelden } from "../src/grafik.mjs";
import { untersuche, huellkurve } from "../src/video.mjs";

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

test("Ton lösen: Teile werden Abschnitte, Übergänge zu Blenden", () => {
  const schnitt = [{ clip: "c1", von: 1, bis: 5 }, { clip: "c2", von: 0, bis: 3, lautstaerke: 0.5, uebergang: { art: "blende", dauer: 0.5 } }];
  assert.deepEqual(tonAusSchnitt(schnitt), [
    { quelle: "c1", von: 1, bis: 5, ab: 0, aus: 0.5 },
    { quelle: "c2", von: 0, bis: 3, ab: 3.5, lautstaerke: 0.5, ein: 0.5 },
  ]);
});

test("Tonspur prüfen: unbekannte Quellen, zu späte und zu kurze Abschnitte fallen weg, Werte begrenzt", () => {
  const quellen = [{ id: "c1", dauer: 10 }, { id: "t1", dauer: 60 }];
  assert.equal(tonspurPruefen(null, quellen, 10), null);
  const spur = tonspurPruefen([
    { quelle: "t1", von: 5, bis: 99, ab: 2, lautstaerke: 7, ein: 99 },
    { quelle: "c1", von: 0, bis: 4, ab: 0, stumm: true },
    { quelle: "x", von: 0, bis: 4, ab: 0 },
    { quelle: "c1", von: 0, bis: 4, ab: 12 },
    { quelle: "c1", von: 3, bis: 3.05, ab: 1 },
  ], quellen, 10);
  assert.deepEqual(spur, [
    { quelle: "c1", von: 0, bis: 4, ab: 0, stumm: true },
    { quelle: "t1", von: 5, bis: 60, ab: 2, lautstaerke: 2, ein: 5 },
  ]);
  assert.deepEqual(tonspurPruefen([], quellen, 10), []); // nur Musik, kein O-Ton
});

test("Untertitel folgen der Tonspur – auch über eine synchrone Tonaufnahme", () => {
  const cues = [{ clip: "c1", start: 1000, end: 2000, text: "Hallo" }, { clip: "c1", start: 5000, end: 6000, text: "Tschüss" }];
  // L-Schnitt: Ton von c1 läuft 1 s weiter, ein Stück ist verschoben
  const spur = [{ quelle: "c1", von: 0, bis: 3, ab: 0 }, { quelle: "c1", von: 5, bis: 6, ab: 10 }];
  assert.deepEqual(tonCues(cues, spur).map((c) => [c.start, c.end, c.text, c.index]), [[1000, 2000, "Hallo", 0], [10000, 11000, "Tschüss", 1]]);
  // Stummer Kamera-Ton zeigt nichts; die synchrone Aufnahme (Aufnahmezeit = Clipzeit + 30 s) zeigt die Clip-Untertitel
  const extern = [{ quelle: "c1", von: 0, bis: 3, ab: 0, stumm: true }, { quelle: "t1", von: 30, bis: 33, ab: 0 }];
  assert.deepEqual(tonCues(cues, extern, [{ id: "t1", sync: [{ clip: "c1", versatz: 30 }] }]).map((c) => [c.start, c.text, c.index]), [[1000, "Hallo", 0]]);
  // Zurück: eine SRT landet bei der Quelle, die an der Stelle zu hören ist
  assert.deepEqual(cuesZurueckTon([{ start: 10200, end: 10800, text: "x" }], spur), [{ clip: "c1", start: 5200, end: 5800, text: "x" }]);
});

/** Sprachähnliches Signal: Silben aus Rauschen mit Pausen, reproduzierbar. */
function silben(sekunden, rate = 16000, saat = 7) {
  let z = saat;
  const zufall = () => ((z = (z * 1103515245 + 12345) % 2147483648) / 2147483648);
  const s = new Float32Array(sekunden * rate);
  for (let t = 0; t < s.length;) {
    const laenge = Math.floor(rate * (0.08 + zufall() * 0.25));
    const pause = Math.floor(rate * (0.05 + zufall() * 0.4));
    const pegel = 0.2 + zufall() * 0.6;
    for (let i = 0; i < laenge && t + i < s.length; i++) s[t + i] = (zufall() * 2 - 1) * pegel * Math.sin((Math.PI * i) / laenge);
    t += laenge + pause;
  }
  return s;
}
function wav(datei, proben, rate = 16000) {
  const daten = Buffer.alloc(44 + proben.length * 2);
  daten.write("RIFF", 0); daten.writeUInt32LE(36 + proben.length * 2, 4); daten.write("WAVEfmt ", 8);
  daten.writeUInt32LE(16, 16); daten.writeUInt16LE(1, 20); daten.writeUInt16LE(1, 22); daten.writeUInt32LE(rate, 24);
  daten.writeUInt32LE(rate * 2, 28); daten.writeUInt16LE(2, 32); daten.writeUInt16LE(16, 34); daten.write("data", 36); daten.writeUInt32LE(proben.length * 2, 40);
  proben.forEach((x, i) => daten.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32000), 44 + i * 2));
  fs.writeFileSync(datei, daten);
}

test("Versatz aus den Lautstärkekurven", () => {
  // Hüllkurven direkt: Clip = Ausschnitt ab 12,34 s der langen Aufnahme, leiser und mit Rauschen
  let z = 3;
  const zufall = () => ((z = (z * 1103515245 + 12345) % 2147483648) / 2147483648);
  const lang = new Float32Array(6000);
  for (let i = 0; i < lang.length;) {
    const n = 8 + Math.floor(zufall() * 25);
    const pegel = zufall() > 0.4 ? 0.1 + zufall() * 0.5 : 0.005;
    lang.fill(pegel, i, i + n);
    i += n;
  }
  const kurz = lang.slice(1234, 1234 + 1500).map((x, i) => x * 0.3 + 0.002 * ((i * 7919) % 13));
  const r = versatzFinden(kurz, lang);
  assert.ok(r, "gefunden");
  assert.equal(r.versatz, 12.34);
  // Nichts Passendes: kein Treffer
  assert.equal(versatzFinden(Float32Array.from({ length: 800 }, (_, i) => ((i * 7919) % 101) / 100), Float32Array.from({ length: 3000 }, () => 0.1)), null);
});

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
schriftenAnmelden(ppicng);

function werkstatt() {
  const datenDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-ton-"));
  const config = {
    datenDir, postiz: null, whisper: null, gesicht: { python: "" }, chatsDatei: path.join(datenDir, "x.json"),
    hochkant: { netze: [] }, caption: { anbieter: null, hashtags: "" },
    zeiten: { titelkarte: 1, abspann: 1, bauchbindeStart: 0.2, bauchbindeDauer: 1 }, video: { encoder: "libx264", preset: "ultrafast", crf: "30" },
    standard: {
      design: "weiss-schwarz-orange", logo: "kein", logoStil: "auto", logoPosition: "oben-links", logoBreite: 0.36, format: "original",
      anpassen: "rand", sharepicFormat: "1:1", untertitel: false, untertitelStil: "box", bauchbinde: null, bauchbindeAn: false, abspannAn: false,
      abspannText: "", tonAngleichen: false, tonRauschen: false, hochkant: false, story: false, absender: "", hashtags: "", postizKunde: "",
    },
  };
  return new Werkstatt({ config, ppicng });
}

test("Ansteckmikrofon: Aufnahme wird am Kamera-Ton ausgerichtet und ersetzt ihn an den Schnitten", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 120000 }, async () => {
  const w = werkstatt();
  const a = w.neu({ plattform: "web", chat: "t", art: "video", von: "t" });
  const ton = silben(40);
  // Kamera: 10 s ab Sekunde 7,5 der Aufnahme, leise und verrauscht; das Mikro hat alles
  const kameraTon = path.join(a.ordner, "kamera.wav");
  wav(kameraTon, ton.slice(7.5 * 16000, 17.5 * 16000).map((x, i) => x * 0.25 + 0.01 * Math.sin(i)));
  const kamera = path.join(a.ordner, "kamera.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=10", "-i", kameraTon, "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", kamera]);
  const mikro = path.join(a.ordner, "mikro.wav");
  wav(mikro, ton);
  await w.videoAnnehmen(a, kamera);
  w.schnittSetzen(a, [{ clip: "c1", von: 0, bis: 4 }, { clip: "c1", von: 6, bis: 10 }]);

  const { tonclip, synchron } = await w.tonclipHinzufuegen(a, mikro, "mikro.wav");
  assert.deepEqual(synchron, ["kamera.mp4"]);
  assert.ok(Math.abs(tonclip.sync[0].versatz - 7.5) < 0.03, `Versatz ${tonclip.sync[0].versatz}`);
  const spur = w.tonspur(a);
  assert.deepEqual(spur.map((s) => [s.quelle, Boolean(s.stumm), s.ab]), [["c1", true, 0], ["t1", false, 0], ["c1", true, 4], ["t1", false, 4]]);
  assert.ok(Math.abs(spur[3].von - 13.5) < 0.03);

  // Rendern: Ton genau so lang wie das Bild, und er kommt vom Mikro (laut), nicht von der leisen Kamera
  await w.bauen(a);
  const info = await untersuche(a.ergebnis);
  assert.ok(Math.abs(info.dauer - 8) < 0.15, `Dauer ${info.dauer}`);
  const pegel = (h) => h.reduce((s, x) => s + x, 0) / h.length;
  const fertig = pegel(await huellkurve(a.ergebnis));
  const nurKamera = pegel(await huellkurve(kamera));
  // Mikro 4× so laut wie die Kamera; Mono → Stereo kostet in ffmpeg 3 dB
  assert.ok(fertig > nurKamera * 1.6, `Mikro-Ton: ${fertig} vs. Kamera ${nurKamera}`);

  // Entfernen: Kamera-Ton wieder hörbar
  w.tonclipEntfernen(a, "t1");
  assert.deepEqual(w.tonspur(a).map((s) => [s.quelle, Boolean(s.stumm)]), [["c1", false], ["c1", false]]);
});

test("Gelöster Ton rendert mit J-Schnitt und Lücke", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 120000 }, async () => {
  const w = werkstatt();
  const a = w.neu({ plattform: "web", chat: "t", art: "video", von: "t" });
  const quelle = path.join(a.ordner, "q.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", quelle]);
  await w.videoAnnehmen(a, quelle);
  // Ton fängt erst bei 2 s an, und der zweite Abschnitt liegt halb über dem ersten
  w.tonspurSetzen(a, [{ quelle: "c1", von: 0, bis: 2, ab: 2, ein: 0.5 }, { quelle: "c1", von: 3, bis: 6, ab: 3.5, lautstaerke: 0.5 }]);
  await w.bauen(a);
  const info = await untersuche(a.ergebnis);
  assert.ok(Math.abs(info.dauer - 6) < 0.15, `Dauer ${info.dauer}`);
  const h = await huellkurve(a.ergebnis);
  const mittel = (von, bis) => h.slice(von * 100, bis * 100).reduce((s, x) => s + x, 0) / ((bis - von) * 100);
  assert.ok(mittel(0.2, 1.8) < 0.005, "am Anfang still");
  assert.ok(mittel(2.6, 3.4) > 0.04, "dann Ton");
  w.tonspurSetzen(a, null);
  assert.equal(w.tonspur(a), null);
});
