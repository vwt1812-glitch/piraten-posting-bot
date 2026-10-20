import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ladePpicng, logoNachId, farbschema } from "../src/ppicng.mjs";
import { schriftenAnmelden } from "../src/grafik.mjs";
import { zielMasse, flaecheFilter, schnittFilter, bauchbindeLage, renderArgs, rendern, untersuche, sichereEndung, tonUntersuchen, fotoNormalisieren } from "../src/video.mjs";
import { zuAss, untertitelGroesse } from "../src/untertitel.mjs";

const ppicng = ladePpicng(new URL("../ppicng", import.meta.url).pathname);
schriftenAnmelden(ppicng);
const ZEITEN = { titelkarte: 1, abspann: 1, bauchbindeStart: 0.2, bauchbindeDauer: 1 };
const VIDEO = { encoder: "libx264", preset: "ultrafast", crf: "30" };
const EINST = { format: "9:16", anpassen: "rand", logoStil: "plakette", logoPosition: "oben-links", logoBreite: 0.36, bauchbindeAn: true, bauchbinde: { name: "Anja Muster", funktion: "Kreisvorsitzende" }, titelkarte: { claim: "Hallo" }, abspannAn: true, abspannText: "piratenpartei.de" };

test("Zielformate", () => {
  assert.deepEqual(zielMasse("original", { breite: 3840, hoehe: 2160 }), { breite: 1920, hoehe: 1080 });
  assert.deepEqual(zielMasse("original", { breite: 720, hoehe: 1280 }), { breite: 720, hoehe: 1280 });
  assert.deepEqual(zielMasse("4:5", { breite: 720, hoehe: 1280 }), { breite: 1080, hoehe: 1350 });
});

test("Fläche: gleiches Format nur skalieren, sonst Rand oder Zuschneiden", () => {
  assert.equal(flaecheFilter({ breite: 720, hoehe: 1280 }, { breite: 1080, hoehe: 1920 }), "scale=1080:1920,setsar=1");
  assert.match(flaecheFilter({ breite: 1920, hoehe: 1080 }, { breite: 1080, hoehe: 1920 }, "zuschneiden"), /crop=1080:1920/);
  assert.match(flaecheFilter({ breite: 1920, hoehe: 1080 }, { breite: 1080, hoehe: 1920 }), /boxblur/);
});

test("Bauchbinde verdeckt die Untertitel nicht", () => {
  for (const masse of [{ breite: 1080, hoehe: 1920 }, { breite: 1920, hoehe: 1080 }, { breite: 1080, hoehe: 1080 }]) {
    for (const lage of [undefined, "mitte", "oben"]) {
      const grafik = { breite: 500, hoehe: 200 };
      const { y } = bauchbindeLage({ masse, grafik, untertitel: true, lage });
      const pos = { oben: masse.hoehe > masse.breite ? 0.62 : 0.8, mitte: masse.hoehe > masse.breite ? 0.47 : 0.42 }[lage] ?? (masse.hoehe > masse.breite ? 0.33 : 0.08);
      const unterkante = masse.hoehe * (1 - pos);
      const oberkante = unterkante - 1.5 * untertitelGroesse(masse);
      assert.ok(y + grafik.hoehe <= oberkante || y >= unterkante, `${masse.breite}x${masse.hoehe} ${lage}: ${y}`);
      assert.ok(y + grafik.hoehe <= masse.hoehe, "im Bild");
    }
  }
});

test("ffmpeg-Aufruf: Titelkarte, Video und Abspann werden verkettet", async () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const { args } = await renderArgs({
    eingabe: "in.mp4", ausgabe: path.join(ordner, "out.mp4"), quelle: { breite: 1920, hoehe: 1080, dauer: 5, hatTon: false },
    e: EINST, schema: farbschema("weiss-schwarz-orange"), logo: logoNachId(ppicng, "common/piraten"), ass: null, fontsDir: "/x", zeiten: ZEITEN, video: VIDEO,
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[titelkartev\]\[titelkartea\]\[haupt\]\[ton\]\[abspannv\]\[abspanna\]concat=n=3:v=1:a=1\[v\]\[a\]/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=0:5\.000\[ta0\]/); // Video ohne Ton bekommt Stille
  for (const datei of ["logo.png", "bauchbinde.png", "titelkarte.png", "abspann.png"]) assert.ok(fs.existsSync(path.join(ordner, datei)), datei);
});

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

test("Schnitt im Filtergraphen: Teile aus mehreren Clips, ein Clip mehrfach", () => {
  const hoch = { breite: 720, hoehe: 1280, hatTon: true };
  const quer = { breite: 1920, hoehe: 1080, hatTon: false };
  const { eingaben, filter } = schnittFilter([
    { datei: "a.mp4", quelle: hoch, von: 1, bis: 3 },
    { datei: "b.mp4", quelle: quer, von: 0, bis: 2 },
    { datei: "a.mp4", quelle: hoch, von: 5, bis: 6.5 },
  ], { breite: 1080, hoehe: 1920 }, "rand");
  assert.deepEqual(eingaben, ["a.mp4", "b.mp4"]);
  const graph = filter.join(";");
  assert.match(graph, /\[0:v\]split=2\[e0v0\]\[e0v1\]/);
  assert.match(graph, /\[0:a\]asplit=2/);
  assert.match(graph, /\[e0v1\]setpts=PTS-STARTPTS,trim=start=5\.000:end=6\.500/);
  assert.match(graph, /\[fgrundt1\]/); // Querformat bekommt den Rand mit eigenen Labels
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=0:2\.000\[ta1\]/); // Clip ohne Ton
  assert.match(graph, /\[tv0\]\[ta0\]\[tv1\]\[ta1\]\[tv2\]\[ta2\]concat=n=3:v=1:a=1\[flaeche\]\[geschnitten\]/);
  const ohneTon = schnittFilter([{ datei: "a.mp4", quelle: hoch, von: 0, bis: 1 }], { breite: 1080, hoehe: 1920 }, "rand", { mitTon: false }).filter.join(";");
  assert.ok(!ohneTon.includes("[geschnitten]") && !ohneTon.includes(":a]"));
});

test("Geschnittenes Video wirklich bauen (zwei Clips, ein Teil herausgeschnitten)", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const a = path.join(ordner, "a.mp4");
  const b = path.join(ordner, "b.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=25:d=4", "-f", "lavfi", "-i", "sine=d=4", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", a]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", b]);
  const qa = await untersuche(a);
  const qb = await untersuche(b);
  const ausgabe = path.join(ordner, "fertig.mp4");
  await rendern({
    teile: [{ datei: a, quelle: qa, von: 0, bis: 1 }, { datei: b, quelle: qb, von: 0.5, bis: 2 }, { datei: a, quelle: qa, von: 3, bis: 4 }],
    ausgabe, e: { ...EINST, titelkarte: null, abspannAn: false }, schema: farbschema("weiss-schwarz-orange"), logo: logoNachId(ppicng, "common/piraten"),
    ass: null, fontsDir: path.dirname(ppicng.schriften.fett), zeiten: ZEITEN, video: VIDEO,
  });
  const fertig = await untersuche(ausgabe);
  assert.ok(Math.abs(fertig.dauer - 3.5) < 0.2, `Dauer ${fertig.dauer}`);
  assert.ok(fertig.hatTon);
  assert.equal(fertig.breite, 1080);
});

test("Video wirklich bauen (ffmpeg)", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const quelle = path.join(ordner, "quelle.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", quelle]);
  const info = await untersuche(quelle);
  const masse = zielMasse("9:16", info);
  const ass = path.join(ordner, "u.ass");
  fs.writeFileSync(ass, zuAss([{ start: 0, end: 2000, text: "Hallo zusammen" }], { ...masse, schrift: "DejaRip", farbe: "#000000", rand: "#ffffff", stil: "box", position: 0.33, zeilen: 1 }));
  const ausgabe = path.join(ordner, "fertig.mp4");
  await rendern({ eingabe: quelle, ausgabe, quelle: info, e: EINST, schema: farbschema("schwarz-weiss-orange"), logo: logoNachId(ppicng, "common/piraten"), ass, fontsDir: path.dirname(ppicng.schriften.fett), zeiten: ZEITEN, video: VIDEO });
  const fertig = await untersuche(ausgabe);
  assert.equal(fertig.breite, 1080);
  assert.equal(fertig.hoehe, 1920);
  assert.ok(Math.abs(fertig.dauer - 4) < 0.3, `Dauer ${fertig.dauer}`);
  assert.ok(fertig.hatTon);
});

test("Ton: Lautstärke je Teil, Blenden am Schnitt, Rauschminderung, Musik mit Ducking, Lautheit", async () => {
  const hoch = { breite: 720, hoehe: 1280, hatTon: true };
  const graph = schnittFilter([{ datei: "a.mp4", quelle: hoch, von: 0, bis: 2, lautstaerke: 1.5 }, { datei: "a.mp4", quelle: hoch, von: 3, bis: 4, stumm: true }], { breite: 1080, hoehe: 1920 }, "rand").filter.join(";");
  assert.match(graph, /volume=1\.5,afade=t=in:d=0\.020,afade=t=out:st=1\.980:d=0\.020\[ta0\]/);
  assert.match(graph, /volume=0,afade/);
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const { args } = await renderArgs({
    eingabe: "in.mp4", ausgabe: path.join(ordner, "out.mp4"), quelle: { breite: 1920, hoehe: 1080, dauer: 5, hatTon: true },
    e: { ...EINST, titelkarte: null, abspannAn: false, ton: { rauschen: true, angleichen: true, musik: { datei: "musik.mp3", lautstaerke: 0.3, ducking: true, ab: 1 } } },
    schema: farbschema("weiss-schwarz-orange"), logo: null, ass: null, fontsDir: "/x", zeiten: ZEITEN, video: VIDEO,
  });
  const g = args[args.indexOf("-filter_complex") + 1];
  assert.match(g, /\[geschnitten\]afftdn/);
  assert.match(g, /atrim=start=1\.000,asetpts=PTS-STARTPTS,atrim=0:5\.000.*volume=0\.3/);
  assert.match(g, /sidechaincompress/);
  assert.match(g, /loudnorm=I=-16/);
  assert.match(g, /\[angeglichen\]anull\[ton\]/);
  assert.equal(args[args.indexOf("musik.mp3") - 7], "-stream_loop"); // Musik läuft in Schleife
  // Ohne Tonbearbeitung bleibt es beim geschnittenen Ton
  const { args: schlicht } = await renderArgs({
    eingabe: "in.mp4", ausgabe: path.join(ordner, "out.mp4"), quelle: { breite: 1920, hoehe: 1080, dauer: 5, hatTon: true },
    e: { ...EINST, titelkarte: null, abspannAn: false, ton: { angleichen: false } }, schema: farbschema("weiss-schwarz-orange"), logo: null, ass: null, fontsDir: "/x", zeiten: ZEITEN, video: VIDEO,
  });
  assert.doesNotMatch(schlicht[schlicht.indexOf("-filter_complex") + 1], /loudnorm|afftdn|amix/);
});

test("Fremde Dateien: nur erlaubte Formate und Endungen", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  assert.equal(sichereEndung("clip.MOV", "video"), ".mov");
  assert.equal(sichereEndung("liste.m3u8", "video"), ".mp4");
  assert.equal(sichereEndung("x.concat", "bild"), ".jpg");
  assert.equal(sichereEndung(undefined, "ton"), ".mp3");
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  // Playlists, die lokale Dateien einbinden wollen, als Video getarnt
  const concat = path.join(ordner, "boese.mp4");
  fs.writeFileSync(concat, "ffconcat version 1.0\nfile /etc/hostname\n");
  await assert.rejects(untersuche(concat));
  const hls = path.join(ordner, "boese2.mp4");
  fs.writeFileSync(hls, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n");
  await assert.rejects(untersuche(hls));
  await assert.rejects(fotoNormalisieren(concat, path.join(ordner, "x.png")));
  await assert.rejects(tonUntersuchen(concat));
  // Echte Musik geht
  const mp3 = path.join(ordner, "musik.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=d=3", mp3]);
  assert.ok((await tonUntersuchen(mp3)).dauer > 2.5);
});

test("Video mit Musik und Tonbearbeitung wirklich bauen", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const quelle = path.join(ordner, "q.mp4");
  const musik = path.join(ordner, "m.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=25:d=3", "-f", "lavfi", "-i", "sine=f=500:d=3", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", quelle]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=200:d=1.2", musik]); // kürzer als das Video → Schleife
  const info = await untersuche(quelle);
  const ausgabe = path.join(ordner, "fertig.mp4");
  await rendern({
    teile: [{ datei: quelle, quelle: info, von: 0, bis: 1.5, lautstaerke: 0.5 }, { datei: quelle, quelle: info, von: 2, bis: 3, stumm: true }],
    ausgabe, e: { ...EINST, titelkarte: null, abspannAn: false, ton: { rauschen: true, angleichen: true, musik: { datei: musik, lautstaerke: 0.4, ducking: true, ab: 0.2 } } },
    schema: farbschema("weiss-schwarz-orange"), logo: null, ass: null, fontsDir: path.dirname(ppicng.schriften.fett), zeiten: ZEITEN, video: VIDEO,
  });
  const fertig = await untersuche(ausgabe);
  assert.ok(Math.abs(fertig.dauer - 2.5) < 0.2, `Dauer ${fertig.dauer}`);
  assert.ok(fertig.hatTon);
});

test("Übergänge: xfade/acrossfade zwischen Teilen, harte Schnitte dazwischen", () => {
  const hoch = { breite: 720, hoehe: 1280, hatTon: true };
  const graph = schnittFilter([
    { datei: "a.mp4", quelle: hoch, von: 0, bis: 3 },
    { datei: "a.mp4", quelle: hoch, von: 4, bis: 6, uebergang: { art: "blende", dauer: 0.5 } },
    { datei: "b.mp4", quelle: hoch, von: 0, bis: 2 },
    { datei: "b.mp4", quelle: hoch, von: 3, bis: 5, uebergang: { art: "schwarz", dauer: 1 } },
  ], { breite: 1080, hoehe: 1920 }, "rand").filter.join(";");
  assert.match(graph, /\[tv0\]\[tv1\]xfade=transition=fade:duration=0\.5:offset=2\.500\[xv1\]/);
  assert.match(graph, /\[ta0\]\[ta1\]acrossfade=d=0\.5/);
  assert.match(graph, /\[xv1\]\[tv2\]concat=n=2:v=1:a=0\[xv2\]/); // harter Schnitt
  // offset = 3 + 2 - 0,5 + 2 - 1 = 5,5
  assert.match(graph, /\[xv2\]\[tv3\]xfade=transition=fadeblack:duration=1:offset=5\.500\[flaeche\]/);
  assert.match(graph, /acrossfade=d=1:c1=tri:c2=tri\[geschnitten\]/);
});

test("Video mit Übergängen wirklich bauen", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-"));
  const a = path.join(ordner, "a.mp4");
  const b = path.join(ordner, "b.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=25:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", a]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", b]); // ohne Ton
  const qa = await untersuche(a);
  const qb = await untersuche(b);
  const ausgabe = path.join(ordner, "fertig.mp4");
  await rendern({
    teile: [
      { datei: a, quelle: qa, von: 0, bis: 2 },
      { datei: b, quelle: qb, von: 0, bis: 2, uebergang: { art: "wischen", dauer: 0.5 } },
      { datei: a, quelle: qa, von: 1, bis: 3, uebergang: { art: "blende", dauer: 1 } },
    ],
    ausgabe, e: { ...EINST, titelkarte: null, abspannAn: false, bauchbindeAn: true }, schema: farbschema("weiss-schwarz-orange"), logo: logoNachId(ppicng, "common/piraten"),
    ass: null, fontsDir: path.dirname(ppicng.schriften.fett), zeiten: ZEITEN, video: VIDEO,
  });
  const fertig = await untersuche(ausgabe);
  assert.ok(Math.abs(fertig.dauer - 4.5) < 0.2, `Dauer ${fertig.dauer}`); // 2 + 2 + 2 − 0,5 − 1
  assert.ok(fertig.hatTon);
});

test("Logo „auto“: auf hellem Grund dunkel, auf dunklem hell", { skip: !ffmpeg && "ffmpeg fehlt" }, async () => {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "ppb-logo-"));
  const ergebnis = {};
  for (const [name, farbe] of [["hell", "0xEDE6DC"], ["dunkel", "0x202428"]]) {
    const ein = path.join(ordner, `${name}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${farbe}:s=640x360:d=2`, "-pix_fmt", "yuv420p", ein]);
    const quelle = await untersuche(ein);
    const aus = path.join(ordner, `${name}.jpg`);
    const { args } = await renderArgs({
      eingabe: ein, quelle, ausgabe: aus, standbild: 1, ass: null, fontsDir: "/x", zeiten: ZEITEN, video: VIDEO,
      e: { ...EINST, format: "original", logoStil: "auto", bauchbindeAn: false, titelkarte: null, abspannAn: false },
      schema: farbschema("weiss-schwarz-orange"), logo: logoNachId(ppicng, "laender/bayern"),
    });
    execFileSync("ffmpeg", args, { cwd: ordner });
    // Schrift „PIRATENPARTEI“ rechts vom Signet: dunkelster bzw. hellster Punkt dort
    const bild = await loadImage(fs.readFileSync(aus));
    const ctx = createCanvas(bild.width, bild.height).getContext("2d");
    ctx.drawImage(bild, 0, 0);
    const d = ctx.getImageData(70, 25, 70, 30).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
    ergebnis[name] = { min, max };
  }
  assert.ok(ergebnis.hell.min < 80, `heller Grund, dunkle Schrift: ${JSON.stringify(ergebnis.hell)}`);
  assert.ok(ergebnis.dunkel.max > 200, `dunkler Grund, helle Schrift: ${JSON.stringify(ergebnis.dunkel)}`);
});
