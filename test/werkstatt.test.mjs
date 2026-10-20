// Werkstatt mit echtem ffmpeg: 9:16-Zweitfassung, Story-Sharepic, Untertitel-Liste über den Schnitt.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Werkstatt } from "../src/werkstatt.mjs";
import { ladePpicng } from "../src/ppicng.mjs";
import { schriftenAnmelden } from "../src/grafik.mjs";
import { untersuche } from "../src/video.mjs";

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
schriftenAnmelden(ppicng);

function werkstatt() {
  const datenDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-werk-"));
  const config = {
    datenDir, postiz: null, whisper: null, gesicht: { python: "" }, chatsDatei: path.join(datenDir, "x.json"),
    hochkant: { netze: ["instagram", "tiktok"] }, caption: { anbieter: null, hashtags: "#Piraten" },
    zeiten: { titelkarte: 1, abspann: 1, bauchbindeStart: 0.2, bauchbindeDauer: 1 }, video: { encoder: "libx264", preset: "ultrafast", crf: "30" },
    standard: {
      design: "weiss-schwarz-orange", logo: "common/piraten", logoStil: "plakette", logoPosition: "oben-links", logoBreite: 0.36, format: "original",
      anpassen: "rand", sharepicFormat: "1:1", untertitel: false, untertitelStil: "box", bauchbinde: null, bauchbindeAn: false, abspannAn: false,
      abspannText: "piratenpartei.de", tonAngleichen: false, tonRauschen: false, hochkant: false, story: false, absender: "", hashtags: "", postizKunde: "",
    },
  };
  return new Werkstatt({ config, ppicng });
}

test("Querformat: Hauptfassung bleibt 16:9, dazu eine 9:16-Fassung für Instagram/TikTok", { skip: !ffmpeg && "ffmpeg fehlt", timeout: 120000 }, async () => {
  const w = werkstatt();
  const a = w.neu({ plattform: "web", chat: "t", art: "video", von: "t" });
  const quelle = path.join(a.ordner, "quer.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", quelle]);
  await w.videoAnnehmen(a, quelle);
  assert.equal(w.istHochkant(a), false);
  assert.equal(w.brauchtZweitfassung(a), false);
  a.e.hochkant = true;
  assert.equal(w.brauchtZweitfassung(a), true);
  await w.bauen(a);
  const haupt = await untersuche(a.ergebnis);
  const hoch = await untersuche(a.hochkantDatei);
  assert.deepEqual([haupt.breite, haupt.hoehe], [640, 360]);
  assert.deepEqual([hoch.breite, hoch.hoehe], [1080, 1920]);
  assert.ok(fs.existsSync(a.hochkantVorschau));
  // Ist das Video schon 9:16, gibt es keine Zweitfassung
  a.e.format = "9:16";
  assert.equal(w.brauchtZweitfassung(a), false);
  a.e.format = "original";
  a.e.hochkant = false;
  await w.bauen(a);
  assert.equal(a.hochkantDatei, null);
});

test("Sharepic mit Story bekommt eine 9:16-Fassung", async () => {
  const w = werkstatt();
  const a = w.neu({ plattform: "web", chat: "t", art: "sharepic", von: "t" });
  Object.assign(a.e, { claim: "Hallo", story: true });
  await w.bauen(a);
  const { loadImage } = await import("@napi-rs/canvas");
  const bild = await loadImage(fs.readFileSync(a.hochkantDatei));
  assert.deepEqual([bild.width, bild.height], [1080, 1920]);
});

test("Untertitel-Liste im Chat: Nummern im Schnitt, Änderungen landen im Clip", () => {
  const w = werkstatt();
  const a = w.neu({ plattform: "web", chat: "t", art: "video", von: "t" });
  // Ohne echte Videodateien: Clips und Schnitt direkt setzen
  w.aendern(a, {
    clips: [{ id: "c1", name: "a", datei: "/x", breite: 1920, hoehe: 1080, dauer: 10, hatTon: true }],
    schnitt: [{ clip: "c1", von: 0, bis: 4 }, { clip: "c1", von: 6, bis: 10 }],
  });
  w.cuesSchreiben(a, [
    { clip: "c1", start: 0, end: 1500, text: "Hallo Kuffner" },
    { clip: "c1", start: 2000, end: 3500, text: "zweiter" },
    { clip: "c1", start: 4500, end: 5500, text: "herausgeschnitten" },
    { clip: "c1", start: 7000, end: 8000, text: "dritter" },
  ]);
  assert.deepEqual(w.untertitelListe(a), ["1 Hallo Kuffner\n2 zweiter\n3 dritter"]);
  const b = w.listeBearbeiten(a, "2 Zweiter Satz.\n3 -\nKuffner => Küffner");
  assert.deepEqual([b.geaendert, b.geloescht, b.ersetzt], [1, 1, 1]);
  assert.deepEqual(w.cues(a).map((c) => c.text), ["Hallo Küffner", "Zweiter Satz.", "herausgeschnitten"]);
  assert.equal(w.listeBearbeiten(a, "irgendwas").erkannt, false);
});
