// Alles, was ffmpeg/ffprobe macht: Video untersuchen, Ton für Whisper herauslösen und das fertige
// Video bauen – Format, Untertitel, Logo, Bauchbinde, Titelkarte und Abspann im ppicng-Design.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { untertitelGroesse, untertitelPosition } from "./untertitel.mjs";
import { UEBERGAENGE, schnittDauer } from "./schnitt.mjs";
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

// ---------- Sicherheit bei fremden Dateien ----------
// Hochgeladene Dateien kommen von außen. ffmpeg erkennt Formate am Inhalt – eine als „video.mp4“ getarnte
// HLS- oder Concat-Playlist könnte es dazu bringen, Dateien des Servers zu lesen und ins Video zu rendern.
// Deshalb liest ffmpeg fremde Dateien nur mit einer Liste erlaubter Formate und nur über das Dateiprotokoll.

export const ERLAUBTE_FORMATE = {
  video: "mov,matroska,avi,mpegts,mpeg,flv",
  bild: "image2,png_pipe,jpeg_pipe,webp_pipe,gif,bmp_pipe,tiff_pipe,mov",
  ton: "mp3,wav,ogg,flac,aac,mov,matroska",
};

export const ERLAUBTE_ENDUNGEN = {
  video: [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mts", ".ts", ".mpg", ".mpeg", ".flv"],
  bild: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"],
  ton: [".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".mka"],
};

/** Endung für eine hochgeladene Datei: nur bekannte, sonst die Standardendung der Art. */
export function sichereEndung(name, art) {
  const endung = path.extname(String(name ?? "")).toLowerCase();
  return ERLAUBTE_ENDUNGEN[art].includes(endung) ? endung : ERLAUBTE_ENDUNGEN[art][0];
}

/** Eingabe-Argumente für eine fremde Datei: nur erlaubte Formate, nur lokale Datei. */
export const eingang = (datei, art = "video") => ["-format_whitelist", ERLAUBTE_FORMATE[art], "-protocol_whitelist", "file", "-i", datei];

/** Maße so, wie das Video angezeigt wird (Drehung von Handyvideos berücksichtigt). */
export async function untersuche(datei) {
  const json = JSON.parse(
    await ausfuehren("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...eingang(datei)]),
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
  await ausfuehren("ffmpeg", ["-y", "-v", "error", ...eingang(video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
}

/** Musik prüfen: erlaubtes Format, mit Tonspur. @returns {Promise<{dauer:number}>} */
export async function tonUntersuchen(datei) {
  const json = JSON.parse(
    await ausfuehren("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...eingang(datei, "ton")]),
  );
  if (!json.streams.some((s) => s.codec_type === "audio")) throw new Error("Die Datei enthält keine Tonspur.");
  const dauer = Number(json.format.duration ?? 0);
  if (!(dauer > 1)) throw new Error("Die Musik ist zu kurz.");
  return { dauer };
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
 * „zuschneiden“: Fläche füllen, Überstand mittig abschneiden. `kennung` macht die inneren Labels eindeutig,
 * wenn mehrere Teile in einem Filtergraphen stehen.
 */
export function flaecheFilter(quelle, ziel, anpassen = "rand", kennung = "") {
  const { breite: w, hoehe: h } = ziel;
  const gleich = Math.abs(quelle.breite / quelle.hoehe - w / h) < 0.01;
  if (gleich) return `scale=${w}:${h},setsar=1`;
  if (anpassen === "zuschneiden") return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  const l = (n) => `[f${n}${kennung}]`;
  return `split${l("grund")}${l("bild")};` +
    `${l("grund")}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=40:2,eq=saturation=0.85${l("unscharf")};` +
    `${l("bild")}scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2${l("vorne")};` +
    `${l("unscharf")}${l("vorne")}overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

/**
 * Schnitt im Filtergraphen: jedes Teil aus seinem Clip herausschneiden, auf die Zielfläche setzen und alle
 * aneinanderhängen – in einem Durchgang mit dem Rest, damit der Pi nur einmal encodieren muss.
 * @param {{datei:string, quelle:{breite:number,hoehe:number,hatTon:boolean}, von:number, bis:number}[]} teile
 * @returns {{eingaben:string[], filter:string[], video:string, ton:string|null}}
 */
export function schnittFilter(teile, masse, anpassen, { mitTon = true } = {}) {
  const eingaben = [...new Set(teile.map((t) => t.datei))];
  const filter = [];
  // Jeder Eingang darf im Graphen nur einmal vorkommen – bei mehreren Teilen aus einem Clip aufteilen
  const quellen = new Map();
  eingaben.forEach((datei, i) => {
    const anzahl = teile.filter((t) => t.datei === datei).length;
    const hatTon = teile.find((t) => t.datei === datei).quelle.hatTon;
    const v = Array.from({ length: anzahl }, (_, k) => `[e${i}v${k}]`);
    const a = Array.from({ length: anzahl }, (_, k) => `[e${i}a${k}]`);
    if (anzahl > 1) filter.push(`[${i}:v]split=${anzahl}${v.join("")}`);
    if (anzahl > 1 && mitTon && hatTon) filter.push(`[${i}:a]asplit=${anzahl}${a.join("")}`);
    quellen.set(datei, { v: anzahl > 1 ? v : [`[${i}:v]`], a: anzahl > 1 ? a : [`[${i}:a]`], naechste: 0 });
  });
  const paare = [];
  teile.forEach((t, k) => {
    const q = quellen.get(t.datei);
    const n = q.naechste++;
    const von = t.von.toFixed(3);
    const bis = t.bis.toFixed(3);
    filter.push(`${q.v[n]}setpts=PTS-STARTPTS,trim=start=${von}:end=${bis},setpts=PTS-STARTPTS,` +
      `${flaecheFilter(t.quelle, masse, anpassen, `t${k}`)},fps=30,format=yuv420p[tv${k}]`);
    if (mitTon) {
      // Lautstärke je Teil, kurze Blenden an jedem Schnitt gegen Knacken
      const laenge = t.bis - t.von;
      const blende = Math.min(0.02, laenge / 4).toFixed(3);
      const lautstaerke = t.stumm ? 0 : (t.lautstaerke ?? 1);
      filter.push(t.quelle.hatTon
        ? `${q.a[n]}asetpts=PTS-STARTPTS,atrim=start=${von}:end=${bis},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,` +
          `volume=${lautstaerke},afade=t=in:d=${blende},afade=t=out:st=${(laenge - Number(blende)).toFixed(3)}:d=${blende}[ta${k}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${laenge.toFixed(3)}[ta${k}]`);
    }
    paare.push(mitTon ? `[tv${k}][ta${k}]` : `[tv${k}]`);
  });
  const mitUebergang = teile.some((t, k) => k > 0 && UEBERGAENGE[t.uebergang?.art]?.xfade);
  if (teile.length > 1 && !mitUebergang) {
    filter.push(`${paare.join("")}concat=n=${teile.length}:v=1:a=${mitTon ? 1 : 0}[flaeche]${mitTon ? "[geschnitten]" : ""}`);
  } else if (teile.length > 1) {
    // Mit Übergängen paarweise: Überblenden (xfade/acrossfade) oder hart aneinanderhängen (concat)
    let v = "tv0";
    let a = "ta0";
    let laenge = teile[0].bis - teile[0].von;
    for (let k = 1; k < teile.length; k++) {
      const t = teile[k];
      const xfade = UEBERGAENGE[t.uebergang?.art]?.xfade;
      const letzter = k === teile.length - 1;
      const vNeu = letzter ? "flaeche" : `xv${k}`;
      const aNeu = letzter ? "geschnitten" : `xa${k}`;
      if (xfade) {
        const d = t.uebergang.dauer;
        filter.push(`[${v}][tv${k}]xfade=transition=${xfade}:duration=${d}:offset=${(laenge - d).toFixed(3)}[${vNeu}]`);
        if (mitTon) filter.push(`[${a}][ta${k}]acrossfade=d=${d}:c1=tri:c2=tri[${aNeu}]`);
        laenge += t.bis - t.von - d;
      } else {
        filter.push(`[${v}][tv${k}]concat=n=2:v=1:a=0[${vNeu}]`);
        if (mitTon) filter.push(`[${a}][ta${k}]concat=n=2:v=0:a=1[${aNeu}]`);
        laenge += t.bis - t.von;
      }
      v = vNeu;
      a = aNeu;
    }
  } else {
    filter.push("[tv0]null[flaeche]");
    if (mitTon) filter.push("[ta0]anull[geschnitten]");
  }
  return { eingaben, filter, video: "flaeche", ton: mitTon ? "geschnitten" : null };
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
 * @param {{datei:string, quelle:object, von:number, bis:number}[]} [o.teile] Schnitt (sonst o.eingabe ganz)
 * @param {string} [o.eingabe] Originalvideo, wenn nicht geschnitten wird
 * @param {{breite:number,hoehe:number,dauer:number,hatTon:boolean}} [o.quelle] Maße des Originals
 * @param {string} o.ausgabe fertiges MP4
 * @param {object} o.e Einstellungen des Beitrags (format, anpassen, logoStil, …)
 * @param {object} o.schema Farbschema
 * @param {object|null} o.logo ppicng-Logo
 * @param {string|null} o.ass ASS-Datei im Ausgabeordner oder null (Zeiten im fertigen Schnitt)
 * @param {string} o.fontsDir Ordner mit DejaRip für die Untertitel
 * @param {object} o.zeiten config.zeiten
 * @param {object} o.video config.video
 * @param {number} [o.standbild] statt des Videos nur ein JPEG dieser Sekunde (ohne Titelkarte, Abspann, Ton)
 */
export async function renderArgs({ teile, eingabe, quelle, ausgabe, e, schema, logo, ass, fontsDir, zeiten, video, standbild }) {
  teile ??= [{ datei: eingabe, quelle, von: 0, bis: Math.max(0.1, quelle.dauer) }];
  const ordner = path.dirname(ausgabe);
  const masse = zielMasse(e.format, teile[0].quelle);
  const dauer = Math.max(0.1, schnittDauer(teile));
  const mitTon = standbild === undefined;
  const schnitt = schnittFilter(teile, masse, e.anpassen, { mitTon });
  const args = ["-y", "-v", "error"];
  for (const d of schnitt.eingaben) args.push(...eingang(d));
  const filter = [...schnitt.filter];
  let eingang_ = schnitt.eingaben.length;
  const bild = async (name, png, loop = null) => {
    const datei = path.join(ordner, name);
    await fs.writeFile(datei, png);
    if (loop) args.push("-loop", "1", "-framerate", "30", "-t", String(loop), "-i", datei);
    else args.push("-i", datei);
    return eingang_++;
  };
  let letzte = schnitt.video;

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

  // Ton nach dem Schnitt: Rauschminderung, Musik (unter Sprache leiser), Lautheit angleichen
  if (mitTon) {
    const ton = e.ton ?? {};
    let t = schnitt.ton;
    if (ton.rauschen) {
      filter.push(`[${t}]afftdn=nr=12:nf=-40[entrauscht]`);
      t = "entrauscht";
    }
    if (ton.musik?.datei) {
      const m = ton.musik;
      args.push("-stream_loop", "-1", ...eingang(m.datei, "ton"));
      const i = eingang_++;
      const aus = Math.min(2, dauer / 3);
      filter.push(`[${i}:a]atrim=start=${(m.ab ?? 0).toFixed(3)},asetpts=PTS-STARTPTS,atrim=0:${dauer.toFixed(3)},aresample=48000,aformat=channel_layouts=stereo,` +
        `volume=${m.lautstaerke ?? 0.25},afade=t=in:d=${Math.min(1, dauer / 4).toFixed(2)},afade=t=out:st=${(dauer - aus).toFixed(3)}:d=${aus.toFixed(2)}[musik]`);
      if (m.ducking !== false) {
        filter.push(`[${t}]asplit[stimme][steuer]`, "[musik][steuer]sidechaincompress=threshold=0.015:ratio=8:attack=30:release=500[geduckt]");
        filter.push("[stimme][geduckt]amix=inputs=2:duration=first:normalize=0[gemischt]");
      } else {
        filter.push(`[${t}][musik]amix=inputs=2:duration=first:normalize=0[gemischt]`);
      }
      t = "gemischt";
    }
    if (ton.angleichen !== false) {
      // Social Media: um -14 bis -16 LUFS; einmal durch, ohne zweiten Messlauf
      filter.push(`[${t}]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[angeglichen]`);
      t = "angeglichen";
    }
    filter.push(`[${t}]anull[ton]`);
  }

  if (standbild !== undefined) {
    filter.push(`[${letzte}]format=yuvj420p[v]`);
    args.push("-filter_complex", filter.join(";"), "-map", "[v]", "-ss", String(standbild), "-frames:v", "1", "-q:v", "3", ausgabe);
    return { args, masse };
  }

  filter.push(`[${letzte}]format=yuv420p[haupt]`);
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

/**
 * Für das Schneiden im Browser: eine kleine Arbeitskopie (H.264, die jeder Browser abspielt, alle 0,4 s ein
 * Keyframe zum genauen Springen), ein Filmstreifen (Bilder nebeneinander) und die Tonwelle.
 * @returns {Promise<{video:string, streifen:string, bilder:number, welle:string|null}>}
 */
export async function arbeitskopie(clip, ordner) {
  const video = path.join(ordner, "arbeitskopie.mp4");
  const streifen = path.join(ordner, "streifen.jpg");
  const welle = path.join(ordner, "welle.png");
  const hochkant = clip.hoehe > clip.breite;
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", ...eingang(clip.datei),
    "-vf", `scale=${hochkant ? "-2:854" : "854:-2"}`, "-r", "25", "-g", "10", "-keyint_min", "10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", video,
  ]);
  const bilder = Math.max(6, Math.min(80, Math.round(clip.dauer / 1.5)));
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", "-i", video,
    "-vf", `fps=${(bilder / clip.dauer).toFixed(5)},scale=-2:72,tile=${bilder}x1`, "-frames:v", "1", "-q:v", "5", streifen,
  ]);
  if (clip.hatTon) {
    await ausfuehren("ffmpeg", [
      "-y", "-v", "error", "-i", video,
      "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1600x80:colors=0xff8800:scale=sqrt", "-frames:v", "1", welle,
    ]);
  }
  return { video, streifen, bilder, welle: clip.hatTon ? welle : null };
}

/** Standbild für Matrix-Vorschaubilder und die KI. */
export async function standbild(eingabe, ausgabe, sekunde = 1) {
  await ausfuehren("ffmpeg", ["-y", "-v", "error", "-ss", String(sekunde), "-i", eingabe, "-frames:v", "1", "-q:v", "4", ausgabe]);
}

/** Beliebiges Foto (auch PNG/WebP) als JPEG für die KI, lange Seite höchstens 1568 px. */
export async function fotoFuerKi(eingabe, ausgabe) {
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", ...eingang(eingabe, "bild"),
    "-vf", "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", "-q:v", "4", ausgabe,
  ]);
}

/** Foto in PNG wandeln, damit canvas es sicher lesen kann (HEIC, WebP, gedrehte JPEGs …). */
export async function fotoNormalisieren(eingabe, ausgabe) {
  await ausfuehren("ffmpeg", [
    "-y", "-v", "error", ...eingang(eingabe, "bild"),
    "-vf", "scale='min(2400,iw)':'min(2400,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", ausgabe,
  ]);
}
