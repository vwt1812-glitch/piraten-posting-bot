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
