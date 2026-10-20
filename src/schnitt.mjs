// Schnitt: Ein Video-Beitrag besteht aus Clips (hochgeladene Dateien) und einer Schnittliste – Teile aus
// diesen Clips in der Reihenfolge, in der sie im fertigen Video laufen:
//   schnitt = [{ clip: "c1", von: 2.5, bis: 10 }, { clip: "c2", von: 0, bis: 4.2, lautstaerke: 0.5 }, …]
//   (Sekunden im Clip; optional lautstaerke 0–2 und stumm je Teil; ab dem zweiten Teil optional
//   uebergang: { art: "blende", dauer: 0.5 } – wie dieser Teil aus dem vorigen hervorgeht)
// Mit Übergang überlappen sich die beiden Teile um dessen Dauer; das Video wird entsprechend kürzer.
// Jeder Teil „gehört“ von seinem Anfang bis zum Anfang des nächsten.
// Untertitel liegen in der Zeit ihres Clips ({ clip, start, end, text }, Millisekunden) und werden erst für
// das fertige Video auf den Schnitt umgerechnet – so bleiben sie richtig, wenn man später anders schneidet.
// web/app.js rechnet im Browser genauso (gleiche Namen, damit man es vergleichen kann).

export const MIN_TEIL = 0.1; // Sekunden – kürzere Teile verwirft der Schnitt
export const MAX_TEILE = 200;

/** Übergänge zwischen Teilen; `xfade` ist der Name des ffmpeg-Übergangs. */
export const UEBERGAENGE = {
  hart: { titel: "harter Schnitt", xfade: null },
  blende: { titel: "Überblendung", xfade: "fade" },
  schwarz: { titel: "über Schwarz", xfade: "fadeblack" },
  weiss: { titel: "über Weiß", xfade: "fadewhite" },
  wischen: { titel: "Wischen", xfade: "wipeleft" },
  schieben: { titel: "Schieben", xfade: "slideleft" },
  kreis: { titel: "Kreis", xfade: "circleopen" },
};
export const UEBERGANG_MIN = 0.1;
export const UEBERGANG_MAX = 2;

export const teilDauer = (t) => t.bis - t.von;
/** Überlappung zwischen Teil i-1 und Teil i (0 bei hartem Schnitt und beim ersten Teil). */
export const ueberlappung = (schnitt, i) => (i > 0 && schnitt[i]?.uebergang ? schnitt[i].uebergang.dauer : 0);
export const schnittDauer = (schnitt) => schnitt.reduce((s, t, i) => s + teilDauer(t) - ueberlappung(schnitt, i), 0);

/** Ganzer Clip als ein Teil. */
export const ganzerClip = (clip) => ({ clip: clip.id, von: 0, bis: clip.dauer });

/**
 * Prüft eine Schnittliste aus dem Browser: nur bekannte Clips, Zeiten im Clip, Teile nicht zu kurz.
 * @param {unknown} schnitt
 * @param {{id:string, dauer:number}[]} clips
 * @returns {{clip:string, von:number, bis:number}[]}
 */
export function schnittPruefen(schnitt, clips) {
  if (!Array.isArray(schnitt)) throw new Error("Schnitt fehlt.");
  const dauer = new Map(clips.map((c) => [c.id, c.dauer]));
  const ergebnis = [];
  for (const t of schnitt.slice(0, MAX_TEILE)) {
    if (!t || !dauer.has(t.clip)) continue;
    const max = dauer.get(t.clip);
    const von = Math.max(0, Math.min(Number(t.von) || 0, max));
    const bis = Math.max(0, Math.min(Number.isFinite(Number(t.bis)) ? Number(t.bis) : max, max));
    if (bis - von < MIN_TEIL) continue;
    const teil = { clip: t.clip, von: Math.round(von * 1000) / 1000, bis: Math.round(bis * 1000) / 1000 };
    // Ton je Teil: Lautstärke 0–200 %, stumm
    const lautstaerke = Number(t.lautstaerke);
    if (Number.isFinite(lautstaerke) && lautstaerke !== 1) teil.lautstaerke = Math.round(Math.max(0, Math.min(2, lautstaerke)) * 100) / 100;
    if (t.stumm === true) teil.stumm = true;
    // Übergang aus dem vorigen Teil: höchstens die halbe Länge des kürzeren der beiden
    const vorher = ergebnis.at(-1);
    const art = t.uebergang?.art;
    if (vorher && UEBERGAENGE[art]?.xfade) {
      const grenze = Math.min(UEBERGANG_MAX, teilDauer(vorher) / 2, teilDauer(teil) / 2);
      const d = Math.min(grenze, Math.max(UEBERGANG_MIN, Number(t.uebergang.dauer) || 0.5));
      if (d >= UEBERGANG_MIN) teil.uebergang = { art, dauer: Math.round(d * 100) / 100 };
    }
    ergebnis.push(teil);
  }
  if (!ergebnis.length) throw new Error("Der Schnitt ist leer – mindestens ein Teil muss bleiben.");
  return ergebnis;
}

/** Wo im fertigen Video beginnt Teil i (mit Übergang: wo er hereinblendet)? */
export function teilAnfaenge(schnitt) {
  const anfaenge = [];
  let t = 0;
  schnitt.forEach((teil, i) => {
    t -= ueberlappung(schnitt, i);
    anfaenge.push(t);
    t += teilDauer(teil);
  });
  return anfaenge;
}

/** Bis wohin im Clip ein Teil „gehört“ – bis der nächste hereinblendet. */
export const eigenesEnde = (schnitt, i) => schnitt[i].bis - ueberlappung(schnitt, i + 1);

/**
 * Zeitpunkt im fertigen Video → Teil und Zeit im Clip.
 * @returns {{index:number, clip:string, t:number}|null}
 */
export function imClip(schnitt, zeit) {
  const anfaenge = teilAnfaenge(schnitt);
  for (let i = 0; i < schnitt.length; i++) {
    const ende = i < schnitt.length - 1 ? anfaenge[i + 1] : anfaenge[i] + teilDauer(schnitt[i]);
    if (zeit < ende || i === schnitt.length - 1) {
      const t = Math.min(schnitt[i].bis, Math.max(schnitt[i].von, schnitt[i].von + zeit - anfaenge[i]));
      return { index: i, clip: schnitt[i].clip, t };
    }
  }
  return null;
}

/**
 * Untertitel der Clips → Untertitel des fertigen Videos (ms). Untertitel, die über einen Schnitt reichen,
 * werden gekürzt; was herausgeschnitten ist, fällt weg. `index` zeigt auf den Untertitel im Clip.
 * @param {{clip:string,start:number,end:number,text:string}[]} cues
 */
export function schnittCues(cues, schnitt) {
  const anfaenge = teilAnfaenge(schnitt);
  const ergebnis = [];
  schnitt.forEach((teil, i) => {
    const von = teil.von * 1000;
    const bis = eigenesEnde(schnitt, i) * 1000;
    const versatz = anfaenge[i] * 1000;
    cues.forEach((c, index) => {
      if (c.clip !== teil.clip || c.end <= von || c.start >= bis) return;
      const start = Math.round(Math.max(c.start, von) - von + versatz);
      const end = Math.round(Math.min(c.end, bis) - von + versatz);
      if (end - start >= 200) ergebnis.push({ start, end, text: c.text, index });
    });
  });
  return ergebnis.sort((a, b) => a.start - b.start);
}

/**
 * Untertitel des fertigen Videos (z. B. eine hochgeladene SRT) → Untertitel der Clips. Reicht einer über
 * einen Schnitt, endet er am Ende seines Teils.
 * @param {{start:number,end:number,text:string}[]} cues in ms im fertigen Video
 */
export function cuesZurueck(cues, schnitt) {
  const ergebnis = [];
  for (const c of cues) {
    const ort = imClip(schnitt, c.start / 1000);
    if (!ort) continue;
    const start = ort.t * 1000;
    const ende = Math.min(eigenesEnde(schnitt, ort.index) * 1000, start + (c.end - c.start));
    const teil = schnitt[ort.index];
    if (ende - start >= 200) ergebnis.push({ clip: teil.clip, start: Math.round(start), end: Math.round(ende), text: c.text });
  }
  return ergebnis;
}

/** Untertitel aus dem Browser prüfen: nur bekannte Clips, sinnvolle Zeiten, Text gekürzt. */
export function cuesPruefen(cues, clips) {
  if (!Array.isArray(cues)) throw new Error("Untertitel fehlen.");
  const dauer = new Map(clips.map((c) => [c.id, c.dauer * 1000]));
  return cues.slice(0, 5000).flatMap((c) => {
    if (!c || !dauer.has(c.clip) || typeof c.text !== "string") return [];
    const start = Math.max(0, Math.round(Number(c.start) || 0));
    const end = Math.min(dauer.get(c.clip), Math.round(Number(c.end) || 0));
    const text = c.text.replace(/\s+/g, " ").trim().slice(0, 300);
    return end - start >= 100 && text ? [{ clip: c.clip, start, end, text }] : [];
  }).sort((a, b) => (a.clip === b.clip ? a.start - b.start : 0));
}

// ---------- Tonspur ----------
// Standardmäßig hängt der Ton am Bild (a.tonspur = null): Jeder Teil bringt seinen Ton mit. Gelöst ist der Ton
// eine eigene Liste von Abschnitten auf der Zeitachse des fertigen Videos (ohne Titelkarte):
//   tonspur = [{ quelle: "c1", von: 2.5, bis: 10, ab: 0, lautstaerke: 0.8, stumm: true, ein: 0.5, aus: 1 }]
// quelle: ein Clip (c1, …) oder eine eigene Tonaufnahme (t1, …, z. B. vom Ansteckmikrofon); von/bis: Sekunden in
// der Quelle; ab: wo der Abschnitt im fertigen Video beginnt; ein/aus: Ein- und Ausblenden (Sekunden).
// Abschnitte dürfen sich überlappen, dann werden sie gemischt – so gehen J- und L-Schnitte und Überblendungen.
// Eine Tonaufnahme kann zu Clips synchron sein (sync: [{ clip, versatz }], Aufnahmezeit = Clipzeit + versatz);
// dann zeigt sie die Untertitel dieser Clips.

export const MAX_TON = 200;
export const TON_BLENDE_MAX = 5;
const r3 = (n) => Math.round(n * 1000) / 1000;
export const tonLaenge = (s) => s.bis - s.von;
export const tonEnde = (s) => s.ab + s.bis - s.von;

/** Gekoppelter Ton als Tonspur – Ausgangspunkt, wenn man den Ton vom Bild löst. Übergänge werden zu Blenden. */
export function tonAusSchnitt(schnitt) {
  const anfaenge = teilAnfaenge(schnitt);
  return schnitt.map((t, i) => {
    const s = { quelle: t.clip, von: t.von, bis: t.bis, ab: r3(anfaenge[i]) };
    if (t.lautstaerke !== undefined && t.lautstaerke !== 1) s.lautstaerke = t.lautstaerke;
    if (t.stumm) s.stumm = true;
    const ein = ueberlappung(schnitt, i);
    const aus = ueberlappung(schnitt, i + 1);
    if (ein) s.ein = ein;
    if (aus) s.aus = aus;
    return s;
  });
}

/**
 * Tonspur aus dem Browser prüfen. null bleibt null (Ton am Bild). Abschnitte, die erst nach dem Ende des
 * Videos beginnen, fallen weg; was über das Ende hinausreicht, schneidet das Rendern ab.
 * @param {unknown} spur
 * @param {{id:string, dauer:number}[]} quellen Clips mit Ton und Tonaufnahmen
 * @param {number} dauer Länge des fertigen Schnitts
 */
export function tonspurPruefen(spur, quellen, dauer) {
  if (spur === null || spur === undefined) return null;
  if (!Array.isArray(spur)) throw new Error("Tonspur fehlt.");
  const laengen = new Map(quellen.map((q) => [q.id, q.dauer]));
  const ergebnis = [];
  for (const s of spur.slice(0, MAX_TON)) {
    if (!s || !laengen.has(s.quelle)) continue;
    const max = laengen.get(s.quelle);
    const von = Math.max(0, Math.min(Number(s.von) || 0, max));
    const bis = Math.max(0, Math.min(Number.isFinite(Number(s.bis)) ? Number(s.bis) : max, max));
    const ab = Math.max(0, Number(s.ab) || 0);
    if (bis - von < MIN_TEIL || ab > dauer - MIN_TEIL) continue;
    const a = { quelle: s.quelle, von: r3(von), bis: r3(bis), ab: r3(ab) };
    const lautstaerke = Number(s.lautstaerke);
    if (Number.isFinite(lautstaerke) && lautstaerke !== 1) a.lautstaerke = Math.round(Math.max(0, Math.min(2, lautstaerke)) * 100) / 100;
    if (s.stumm === true) a.stumm = true;
    for (const feld of ["ein", "aus"]) {
      const d = Math.min(TON_BLENDE_MAX, (bis - von) / 2, Math.max(0, Number(s[feld]) || 0));
      if (d >= 0.05) a[feld] = Math.round(d * 100) / 100;
    }
    ergebnis.push(a);
  }
  return ergebnis.sort((x, y) => x.ab - y.ab);
}

/**
 * Untertitel je Quelle in deren Zeit: eigene, und bei synchronen Tonaufnahmen die der Clips (verschoben).
 * `index` zeigt weiter auf den Untertitel im Clip – so lassen sich Änderungen zurückschreiben.
 * @param {{id:string, sync?:{clip:string, versatz:number}[]}[]} tonclips
 */
export function cuesJeQuelle(cues, tonclips = []) {
  const je = new Map();
  cues.forEach((c, index) => {
    if (!je.has(c.clip)) je.set(c.clip, []);
    je.get(c.clip).push({ ...c, index });
  });
  for (const t of tonclips) {
    if (je.has(t.id) || !t.sync?.length) continue; // eigene Untertitel gehen vor
    const liste = [];
    for (const { clip, versatz } of t.sync) {
      for (const c of je.get(clip) ?? []) liste.push({ ...c, clip: t.id, start: c.start + versatz * 1000, end: c.end + versatz * 1000 });
    }
    je.set(t.id, liste);
  }
  return je;
}

/** Untertitel des fertigen Videos bei gelöstem Ton: Sie folgen den hörbaren Abschnitten der Tonspur. */
export function tonCues(cues, spur, tonclips = []) {
  const je = cuesJeQuelle(cues, tonclips);
  const ergebnis = [];
  for (const s of spur) {
    if (s.stumm || s.lautstaerke === 0) continue;
    const von = s.von * 1000;
    const bis = s.bis * 1000;
    const versatz = s.ab * 1000;
    for (const c of je.get(s.quelle) ?? []) {
      if (c.end <= von || c.start >= bis) continue;
      const start = Math.round(Math.max(c.start, von) - von + versatz);
      const end = Math.round(Math.min(c.end, bis) - von + versatz);
      if (end - start >= 200) ergebnis.push({ start, end, text: c.text, index: c.index });
    }
  }
  // Derselbe Untertitel aus zwei überlappenden Abschnitten nur einmal
  const gesehen = new Set();
  return ergebnis.sort((a, b) => a.start - b.start).filter((c) => {
    const k = `${c.index}:${Math.round(c.start / 500)}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
}

/** Wie cuesZurueck, aber über die Tonspur: Der Untertitel gehört zur Quelle des hörbaren Abschnitts an seinem Anfang. */
export function cuesZurueckTon(cues, spur) {
  const ergebnis = [];
  for (const c of cues) {
    const t = c.start / 1000;
    const s = spur.findLast((x) => !x.stumm && x.ab <= t && t < tonEnde(x));
    if (!s) continue;
    const start = (s.von + t - s.ab) * 1000;
    const ende = Math.min(s.bis * 1000, start + (c.end - c.start));
    if (ende - start >= 200) ergebnis.push({ clip: s.quelle, start: Math.round(start), end: Math.round(ende), text: c.text });
  }
  return ergebnis;
}

/**
 * Versatz zwischen zwei Tonaufnahmen derselben Szene über ihre Lautstärkekurven (je 10 ms ein Wert):
 * erst grob (100 ms), dann fein um den besten Treffer. Aufnahmezeit in `lang` = Zeit in `kurz` + versatz.
 * @param {Float32Array} kurz Hüllkurve des Clips
 * @param {Float32Array} lang Hüllkurve der Tonaufnahme
 * @returns {{versatz:number, guete:number}|null} versatz in Sekunden, guete = Korrelation (0–1)
 */
export function versatzFinden(kurz, lang, raster = 0.01) {
  // Anstiege statt Pegel: unabhängig davon, wie laut und mit welchem Mikrofon aufgenommen wurde
  const anstiege = (h) => {
    const d = new Float32Array(h.length);
    for (let i = 1; i < h.length; i++) d[i] = Math.max(0, h[i] - h[i - 1]);
    return d;
  };
  const verdichten = (h, n) => {
    const d = new Float32Array(Math.floor(h.length / n));
    for (let i = 0; i < d.length; i++) for (let k = 0; k < n; k++) d[i] += h[i * n + k];
    return d;
  };
  const korrelation = (a, b, lag, schritt = 1) => {
    // Pearson über den überlappenden Bereich; lag: a[i] ↔ b[i + lag]
    const von = Math.max(0, -lag);
    const bis = Math.min(a.length, b.length - lag);
    if (bis - von < a.length * 0.5) return -1;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let i = von; i < bis; i += schritt) {
      const x = a[i], y = b[i + lag];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n++;
    }
    const kov = sab - (sa * sb) / n;
    const nenner = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
    return nenner > 0 ? kov / nenner : -1;
  };
  const a = anstiege(log(kurz));
  const b = anstiege(log(lang));
  const g = 10;
  const ag = verdichten(a, g);
  const bg = verdichten(b, g);
  let besterLag = 0, beste = -1;
  for (let lag = -Math.floor(ag.length / 2); lag <= bg.length - Math.floor(ag.length / 2); lag++) {
    const k = korrelation(ag, bg, lag);
    if (k > beste) [beste, besterLag] = [k, lag];
  }
  if (beste < 0.25) return null;
  let fein = besterLag * g, guete = -1;
  for (let lag = besterLag * g - 2 * g; lag <= besterLag * g + 2 * g; lag++) {
    const k = korrelation(a, b, lag);
    if (k > guete) [guete, fein] = [k, lag];
  }
  return guete >= 0.25 ? { versatz: r3(fein * raster), guete: Math.round(guete * 100) / 100 } : null;
}

const log = (h) => h.map((x) => Math.log10(1e-4 + x));
