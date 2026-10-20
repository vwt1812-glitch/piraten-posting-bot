// Alles, was ffmpeg/ffprobe macht: Video untersuchen, Ton für Whisper herauslösen und das fertige
// Video bauen – Format, Untertitel, Logo, Bauchbinde, Titelkarte und Abspann im ppicng-Design.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { untertitelGroesse, untertitelPosition } from "./untertitel.mjs";
import { sharepic, logoPlakette, bauchbinde, eigenesBild, gerade, raender, logoLage } from "./grafik.mjs";

export { raender, logoLage };

export function ausfuehren(befehl, args, { cwd, binaer = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(befehl, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
    p.on("error", (e) => reject(new Error(`${befehl} nicht gefunden oder nicht startbar: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${befehl} ist fehlgeschlagen (Code ${code}):\n${err.trim().split("\n").slice(-6).join("\n")}`));
      const daten = Buffer.concat(out);
      resolve(binaer ? daten : daten.toString());
    });
  });
}

/** Maße so, wie das Video angezeigt wird (Drehung von Handyvideos berücksichtigt). */
export async function untersuche(datei) {
  const json = JSON.parse(
    await ausfuehren("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", datei]),
  );
  const video = json.streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error("Die Datei enthält keine Videospur.");
  const drehung = Math.abs(
    Number(video.tags?.rotate ?? video.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0),
  );
  const gedreht = drehung === 90 || drehung === 270;
  return {
    breite: gedreht ? video.height : video.width,
    hoehe: gedreht ? video.width : video.height,
    dauer: Number(json.format.duration ?? video.duration ?? 0),
    hatTon: json.streams.some((s) => s.codec_type === "audio"),
  };
}

export async function tonFuerWhisper(video, wav) {
  await ausfuehren("ffmpeg", ["-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
}

// ---------- Formate ----------

/** Zielformate. „original“ behält das Seitenverhältnis, kurze Seite höchstens 1080 px. */
export const FORMATE = {
  original: { titel: "Original" },
  "9:16": { titel: "9:16 hochkant (Reels, TikTok, Storys)", breite: 1080, hoehe: 1920 },
  "4:5": { titel: "4:5 (Instagram-Feed)", breite: 1080, hoehe: 1350 },
  "1:1": { titel: "1:1 quadratisch", breite: 1080, hoehe: 1080 },
  "16:9": { titel: "16:9 quer (YouTube)", breite: 1920, hoehe: 1080 },
};

export function zielMasse(format, masse) {
  const f = FORMATE[format];
  if (f?.breite) return { breite: f.breite, hoehe: f.hoehe };
  const faktor = Math.min(1, 1080 / Math.min(masse.breite, masse.hoehe));
  return { breite: gerade(masse.breite * faktor), hoehe: gerade(masse.hoehe * faktor) };
}

/**
 * Filter vom Originalbild auf die Zielfläche. „rand“: ganzes Bild, Rest mit unscharfer Kopie aufgefüllt;
 * „zuschneiden“: Fläche füllen, Überstand mittig abschneiden.
 */
export function flaecheFilter(quelle, ziel, anpassen = "rand") {
  const { breite: w, hoehe: h } = ziel;
  const gleich = Math.abs(quelle.breite / quelle.hoehe - w / h) < 0.01;
  if (gleich) return `scale=${w}:${h},setsar=1`;
  if (anpassen === "zuschneiden") return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  return `split[fgrund][fbild];` +
    `[fgrund]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=40:2,eq=saturation=0.85[funscharf];` +
    `[fbild]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2[fvorne];` +
    `[funscharf][fvorne]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

// ---------- Lage der Grafiken ----------

/**
 * Bauchbinde links unten – hochkant über Name und Caption von TikTok/Reels (die belegen die unteren
 * gut 20 %), und so, dass sie die Untertitel nicht verdeckt.
 */
export function bauchbindeLage({ masse, grafik, untertitel, lage }) {
  const { rand } = raender(masse);
  const hochkant = masse.hoehe > masse.breite;
  let unten = hochkant ? masse.hoehe * 0.76 : masse.hoehe - 1.5 * rand;
  if (untertitel) {
    // Untertitel stehen einzeilig (UNTERTITEL_ZEILEN=1): Oberkante ≈ 1,5 Schriftgrößen über der Grundlinie
    const unterkante = masse.hoehe * (1 - untertitelPosition({ ...masse, lage, position: 0.33 }));
    const oberkante = unterkante - 1.5 * untertitelGroesse(masse);
    const ueberlappt = unten > oberkante && unten - grafik.hoehe < unterkante;
    // Lieber unter die Untertitel (bis 80 % der Höhe, darunter blenden die Apps ein), sonst darüber
    const darunter = unterkante + rand / 2 + grafik.hoehe;
    if (ueberlappt) unten = darunter <= masse.hoehe * (hochkant ? 0.8 : 1) - (hochkant ? 0 : rand) ? darunter : oberkante - rand / 2;
  }
  return { x: rand, y: Math.max(rand, Math.round(unten - grafik.hoehe)) };
}

// ---------- Rendern ----------

/**
 * Grafiken für ein Video erzeugen und die ffmpeg-Argumente bauen.
 * @param {object} o
 * @param {string} o.eingabe Originalvideo
 * @param {string} o.ausgabe fertiges MP4
 * @param {{breite:number,hoehe:number,dauer:number,hatTon:boolean}} o.quelle Maße des Originals
 * @param {object} o.e Einstellungen des Beitrags (format, anpassen, logoStil, …)
 * @param {object} o.schema Farbschema
 * @param {object|null} o.logo ppicng-Logo
 * @param {string|null} o.ass ASS-Datei im Ausgabeordner oder null
 * @param {string} o.fontsDir Ordner mit DejaRip für die Untertitel
 * @param {object} o.zeiten config.zeiten
 * @param {object} o.video config.video
 */
export async function renderArgs({ eingabe, ausgabe, quelle, e, schema, logo, ass, fontsDir, zeiten, video }) {
  const ordner = path.dirname(ausgabe);
  const masse = zielMasse(e.format, quelle);
  const dauer = Math.max(0.1, quelle.dauer);
  const args = ["-y", "-v", "error", "-i", eingabe];
  const filter = [];
  let eingang = 1;
  const bild = async (name, png, loop = null) => {
    const datei = path.join(ordner, name);
    await fs.writeFile(datei, png);
    if (loop) args.push("-loop", "1", "-framerate", "30", "-t", String(loop), "-i", datei);
    else args.push("-i", datei);
    return eingang++;
  };

  filter.push(`[0:v]${flaecheFilter(quelle, masse, e.anpassen)},fps=30[flaeche]`);
  let letzte = "flaeche";

  if (ass) {
    filter.push(`[${letzte}]ass=${path.basename(ass)}:fontsdir=${fontsDir.replace(/[\\:']/g, "\\$&")}[sub]`);
    letzte = "sub";
  }

  if (logo) {
    const g = await logoPlakette({ logo, schema, logoBreite: Math.min(masse.breite, masse.hoehe) * e.logoBreite, stil: e.logoStil });
    const i = await bild("logo.png", g.png);
    const { x, y } = logoLage({ masse, grafik: g, position: e.logoPosition });
    filter.push(`[${letzte}][${i}:v]overlay=${x}:${y}:format=auto[mitlogo]`);
    letzte = "mitlogo";
  }

  if (e.bauchbindeAn && e.bauchbinde?.name) {
    const kurz = Math.min(masse.breite, masse.hoehe);
    const g = await bauchbinde({ ...e.bauchbinde, schema, einheit: kurz * 0.07, maxBreite: masse.breite - 2 * raender(masse).rand });
    const start = Math.min(zeiten.bauchbindeStart, Math.max(0, dauer - 1));
    const d = 0.35; // Ein- und Ausblenden
    const ende = Math.max(start + d, Math.min(start + zeiten.bauchbindeDauer, dauer - d - 0.05));
    const i = await bild("bauchbinde.png", g.png, Math.max(dauer, 1));
    const { x, y } = bauchbindeLage({ masse, grafik: g, untertitel: Boolean(ass), lage: e.untertitelLage });
    const weg = Math.round(kurz * 0.06); // so weit gleitet sie herein
    filter.push(`[${i}:v]format=rgba,fade=t=in:st=${start}:d=${d}:alpha=1,fade=t=out:st=${ende}:d=${d}:alpha=1[binde]`);
    filter.push(`[${letzte}][binde]overlay=x='${x}-${weg}*pow(max(0,1-(t-${start})/${d}),2)':y=${y}:enable='between(t,${start},${ende + d})':eof_action=pass:format=auto[mitbinde]`);
    letzte = "mitbinde";
  }

  // Karten vorne und hinten: eigenes Bild (z. B. aus der ppicng-Web-App) oder Karte im Design
  const karte = async (art, k, sekunden) => {
    if (!k) return null;
    const png = k.bild
      ? await eigenesBild({ ...masse, bild: k.bild, schema })
      : await sharepic({ ...masse, schema, claim: k.claim ?? "", text: k.text ?? "", logo });
    const i = await bild(`${art}.png`, png, sekunden);
    const fade = art === "titelkarte" ? `fade=t=out:st=${Math.max(0, sekunden - 0.3)}:d=0.3` : "fade=t=in:st=0:d=0.3";
    filter.push(`[${i}:v]scale=${masse.breite}:${masse.hoehe},setsar=1,fps=30,format=yuv420p,${fade}[${art}v]`);
    filter.push(`anullsrc=r=48000:cl=stereo,atrim=0:${sekunden}[${art}a]`);
    return art;
  };
  const vorne = await karte("titelkarte", e.titelkarte, zeiten.titelkarte);
  const hinten = await karte("abspann", e.abspannAn ? (e.abspann ?? { claim: e.abspannText }) : null, zeiten.abspann);

  filter.push(`[${letzte}]format=yuv420p[haupt]`);
  filter.push(quelle.hatTon
    ? `[0:a]aresample=48000,aformat=channel_layouts=stereo[ton]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${dauer}[ton]`);
  if (vorne || hinten) {
    const teile = [vorne, "haupt", hinten].filter(Boolean);
    const paare = teile.map((t) => (t === "haupt" ? "[haupt][ton]" : `[${t}v][${t}a]`)).join("");
    filter.push(`${paare}concat=n=${teile.length}:v=1:a=1[v][a]`);
  } else {
    filter.push(`[haupt]null[v]`, `[ton]anull[a]`);
  }

  args.push("-filter_complex", filter.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", video.encoder);
  if (video.encoder === "libx264") args.push("-preset", video.preset, "-crf", String(video.crf), "-profile:v", "high");
  else args.push("-b:v", "8M");
  args.push("-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", ausgabe);
  return { args, masse };
}

export async function rendern(o) {
  const { args, masse } = await renderArgs(o);
  await ausfuehren("ffmpeg", args, { cwd: path.dirname(o.ausgabe) });
  return masse;
}

/** Kleinere Fassung für die Vorschau im Chat (Telegram-Bot-API: max. 50 MB). */
export async function vorschau(eingabe, ausgabe) {
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", "-i", eingabe,
    "-vf", "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart", ausgabe,
  ]);
}

/** Standbild für Matrix-Vorschaubilder und die KI. */
export async function standbild(eingabe, ausgabe, sekunde = 1) {
  await ausfuehren("ffmpeg", ["-y", "-v", "error", "-ss", String(sekunde), "-i", eingabe, "-frames:v", "1", "-q:v", "4", ausgabe]);
}

/** Beliebiges Foto (auch PNG/WebP) als JPEG für die KI, lange Seite höchstens 1568 px. */
export async function fotoFuerKi(eingabe, ausgabe) {
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", "-i", eingabe,
    "-vf", "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", "-q:v", "4", ausgabe,
  ]);
}

/** Foto in PNG wandeln, damit canvas es sicher lesen kann (HEIC, WebP, gedrehte JPEGs …). */
export async function fotoNormalisieren(eingabe, ausgabe) {
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", "-i", eingabe,
    "-vf", "scale='min(2400,iw)':'min(2400,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", ausgabe,
  ]);
}
