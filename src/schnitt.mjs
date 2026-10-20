// Schnitt: Ein Video-Beitrag besteht aus Clips (hochgeladene Dateien) und einer Schnittliste – Teile aus
// diesen Clips in der Reihenfolge, in der sie im fertigen Video laufen:
//   schnitt = [{ clip: "c1", von: 2.5, bis: 10 }, { clip: "c2", von: 0, bis: 4.2 }, …]   (Sekunden im Clip)
// Untertitel liegen in der Zeit ihres Clips ({ clip, start, end, text }, Millisekunden) und werden erst für
// das fertige Video auf den Schnitt umgerechnet – so bleiben sie richtig, wenn man später anders schneidet.
// web/app.js rechnet im Browser genauso (gleiche Namen, damit man es vergleichen kann).

export const MIN_TEIL = 0.1; // Sekunden – kürzere Teile verwirft der Schnitt
export const MAX_TEILE = 200;

export const teilDauer = (t) => t.bis - t.von;
export const schnittDauer = (schnitt) => schnitt.reduce((s, t) => s + teilDauer(t), 0);

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
    if (bis - von >= MIN_TEIL) ergebnis.push({ clip: t.clip, von: Math.round(von * 1000) / 1000, bis: Math.round(bis * 1000) / 1000 });
  }
  if (!ergebnis.length) throw new Error("Der Schnitt ist leer – mindestens ein Teil muss bleiben.");
  return ergebnis;
}

/** Wo im fertigen Video beginnt Teil i? */
export function teilAnfaenge(schnitt) {
  const anfaenge = [];
  let t = 0;
  for (const teil of schnitt) {
    anfaenge.push(t);
    t += teilDauer(teil);
  }
  return anfaenge;
}

/**
 * Zeitpunkt im fertigen Video → Teil und Zeit im Clip.
 * @returns {{index:number, clip:string, t:number}|null}
 */
export function imClip(schnitt, zeit) {
  const anfaenge = teilAnfaenge(schnitt);
  for (let i = 0; i < schnitt.length; i++) {
    const ende = anfaenge[i] + teilDauer(schnitt[i]);
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
    const bis = teil.bis * 1000;
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
    const teil = schnitt[ort.index];
    const start = ort.t * 1000;
    const ende = Math.min(teil.bis * 1000, start + (c.end - c.start));
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
