// Web-Version des Piraten-Posting-Bots: Sharepics und Videos im ppicng-Design.
// Ohne Framework und ohne Build-Schritt; alle Texte aus dem Netz kommen per textContent in die Seite.

"use strict";

const app = document.getElementById("app");
let optionen = null;
let abbruch = null; // läuft ab, wenn die Ansicht wechselt (Abfragen, Vorschau)

// ---------- Hilfen ----------

/** Element bauen: el("button", { class: "x", onclick }, "Text", kind …) */
function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v); // CSSOM statt Attribut – die CSP erlaubt keine Inline-Styles
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  for (const kind of kinder.flat(Infinity)) if (kind !== null && kind !== undefined && kind !== false) e.append(kind instanceof Node ? kind : String(kind));
  return e;
}

/** Wie replaceChildren, aber null/undefined/false werden weggelassen (statt als Text „null“ zu erscheinen). */
function ersetzen(ziel, ...kinder) {
  ziel.replaceChildren(...kinder.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

async function anfrage(pfad, { methode = "GET", json, body, kopf = {}, roh = false } = {}) {
  const res = await fetch(`/api/${pfad}`, {
    method: methode,
    headers: { ...(methode !== "GET" ? { "X-PPB": "1" } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...kopf },
    body: json !== undefined ? JSON.stringify(json) : body,
    signal: abbruch?.signal,
  });
  if (res.status === 401 && pfad !== "anmelden") {
    start();
    throw new Error("Bitte anmelden.");
  }
  if (!res.ok) {
    const daten = await res.json().catch(() => ({}));
    const fehler = new Error(daten.fehler ?? `Fehler ${res.status}`);
    Object.assign(fehler, { status: res.status, daten });
    throw fehler;
  }
  return roh ? res : res.json();
}

/** Upload mit Fortschrittsbalken (fetch kann das noch nicht). */
function hochladen(pfad, datei, fortschritt) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/${pfad}`);
    xhr.setRequestHeader("X-PPB", "1");
    xhr.setRequestHeader("Content-Type", datei.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && fortschritt?.(e.loaded / e.total);
    xhr.onload = () => {
      let daten = {};
      try {
        daten = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(daten);
      else reject(new Error(daten.fehler ?? `Fehler ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Verbindung abgebrochen."));
    xhr.send(datei);
  });
}

const verzoegert = (fn, ms) => {
  let t = null;
  let offen = null; // Argumente eines noch nicht ausgeführten Aufrufs
  const f = (...args) => {
    clearTimeout(t);
    offen = args;
    t = setTimeout(() => {
      offen = null;
      fn(...args);
    }, ms);
  };
  f.sofort = (...args) => {
    clearTimeout(t);
    offen = null;
    return fn(...args);
  };
  /** Steht noch etwas aus? Dann jetzt ausführen und abwarten. */
  f.jetzt = async () => {
    if (!offen) return;
    clearTimeout(t);
    const args = offen;
    offen = null;
    await fn(...args);
  };
  return f;
};

function meldung(ziel, text, art = "fehler") {
  ersetzen(ziel, text ? el("p", { class: art, role: art === "fehler" ? "alert" : "status" }, text) : "");
}

const logoUrl = (id, schrift = "000000") => `/api/logo/${id}?schrift=${schrift.replace("#", "")}`;

// ---------- Anmeldung ----------

let modus = "anmeldung";

async function zeigeAnmeldung({ anmeldung }) {
  document.getElementById("nav").hidden = true;
  const fehler = el("div");
  let art = anmeldung.matrix ? "matrix" : "passwort";
  const nutzer = el("input", { type: "text", id: "nutzer", autocomplete: "username" });
  const passwort = el("input", { type: "password", id: "passwort", autocomplete: "current-password", required: true });
  const nutzerLabel = el("label", { for: "nutzer" });
  const umschalten = () => {
    nutzerLabel.textContent = art === "matrix" ? `Matrix-Name (z. B. anja oder @anja:${anmeldung.matrixServer})` : "Dein Name (optional)";
    nutzer.required = art === "matrix";
  };
  umschalten();
  const wahl = anmeldung.matrix && anmeldung.passwort
    ? el("div", { class: "reihe" },
      ...[["matrix", `Matrix-Konto (${anmeldung.matrixServer})`], ["passwort", "Team-Passwort"]].map(([wert, text]) =>
        el("label", { class: "zeile" }, el("input", { type: "radio", name: "art", value: wert, checked: art === wert, onchange: () => { art = wert; umschalten(); } }), text)))
    : null;
  const form = el("form", {
    class: "karte anmelden",
    onsubmit: async (ev) => {
      ev.preventDefault();
      meldung(fehler, "");
      try {
        await anfrage("anmelden", { methode: "POST", json: { nutzer: nutzer.value, passwort: passwort.value, art } });
        start();
      } catch (e) {
        meldung(fehler, e.message);
      }
    },
  },
  el("h1", {}, "Anmelden"),
  el("p", { class: "leise" }, "Videos und Sharepics im einheitlichen Design der Piratenpartei."),
  wahl, nutzerLabel, nutzer,
  el("label", { for: "passwort" }, "Passwort"), passwort,
  fehler,
  el("p", {}, el("button", { type: "submit" }, "Anmelden")),
  anmeldung.matrix ? el("p", { class: "leise" }, "Dein Passwort geht nur einmal an deinen Matrix-Server zur Prüfung und wird nicht gespeichert.") : null);
  ersetzen(app, form);
  (anmeldung.matrix ? nutzer : passwort).focus();
}

document.getElementById("abmelden").addEventListener("click", async () => {
  await anfrage("abmelden", { methode: "POST" }).catch(() => {});
  optionen = null;
  start();
});

// ---------- Startseite ----------

function startseite() {
  const fehler = el("div");
  const fortschritt = el("div", { class: "fortschritt", hidden: true }, el("div"));
  const datei = el("input", { type: "file", accept: "video/*,image/*", class: "unsichtbar", id: "datei" });
  datei.addEventListener("change", async () => {
    const f = datei.files[0];
    if (!f) return;
    if (f.size > optionen.maxMb * 1024 * 1024) return meldung(fehler, `Die Datei ist zu groß (höchstens ${optionen.maxMb} MB).`);
    meldung(fehler, "");
    fortschritt.hidden = false;
    try {
      const a = await hochladen(`hochladen?name=${encodeURIComponent(f.name)}`, f, (p) => (fortschritt.firstChild.style.width = `${Math.round(p * 100)}%`));
      location.hash = `#/a/${a.id}`;
    } catch (e) {
      meldung(fehler, e.message);
      fortschritt.hidden = true;
    }
  });
  const neuesSharepic = async () => {
    try {
      const a = await anfrage("sharepic", { methode: "POST", json: { e: { claim: "Klarmachen zum Ändern!" } } });
      location.hash = `#/a/${a.id}`;
    } catch (e) {
      meldung(fehler, e.message);
    }
  };
  ersetzen(app, 
    el("h1", {}, "Was möchtest du gestalten?"),
    el("div", { class: "start" },
      el("div", { class: "karte" },
        el("h2", {}, "🖼️ Sharepic"),
        el("p", {}, "Claim, Erklärtext und Logo – wie in ppicng. Optional mit Foto."),
        el("button", { onclick: neuesSharepic }, "Sharepic erstellen")),
      el("div", { class: "karte" },
        el("h2", {}, "🎬 Video oder Foto"),
        el("p", {}, optionen.funktionen.whisper
          ? "Logo, Untertitel (automatisch erkannt), Bauchbinde, Titelkarte und Abspann im Design der Partei."
          : "Logo, Untertitel (als SRT), Bauchbinde, Titelkarte und Abspann im Design der Partei."),
        el("label", { for: "datei", class: "knopf", tabindex: "0", onkeydown: (e) => (e.key === "Enter" || e.key === " ") && datei.click() }, "Datei auswählen"),
        datei, fortschritt,
        el("p", { class: "leise" }, `Bis ${optionen.maxMb} MB. Fotos werden zum Sharepic mit Foto bzw. zum Foto mit Logo.`))),
    fehler,
    modus === "offen" ? el("p", { class: "leise" }, "Ohne Anmeldung: Deine Projekte hängen an diesem Browser. Wer den Browser-Speicher löscht, kommt nicht mehr an sie heran – fertige Dateien also herunterladen.") : null,
    optionen.ppicngUrl ? el("p", { class: "leise" }, "Mehr Designs für Bilder gibt es in ", el("a", { href: optionen.ppicngUrl, rel: "noopener" }, "ppicng"), ".") : null,
  );
}

async function meineSeite() {
  const liste = await anfrage("auftraege");
  const statusText = { entwurf: "Entwurf", bereit: "fertig", gepostet: "gepostet", geplant: "geplant", arbeitet: "in Arbeit", fehler: "Fehler" };
  ersetzen(app, 
    el("h1", {}, "Meine Beiträge"),
    liste.length
      ? el("ul", { class: "liste" }, liste.map((a) => el("li", {}, el("a", { href: `#/a/${a.id}` },
        el("span", {}, `${a.art === "video" ? "🎬" : "🖼️"} ${a.titel}`),
        el("span", { class: "leise" }, `${statusText[a.status] ?? a.status} · ${new Date(a.erstellt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}`)))))
      : el("p", { class: "leise" }, "Noch nichts – leg los unter „Neu“."),
    el("p", { class: "leise" }, "Beiträge werden nach 14 Tagen gelöscht."),
  );
}

// ---------- Schnitt (gleiche Rechnung wie src/schnitt.mjs) ----------

const teilDauer = (t) => t.bis - t.von;
// Mit Übergang überlappen sich zwei Teile um dessen Dauer; jeder Teil gehört bis zum Anfang des nächsten
const ueberlappung = (schnitt, i) => (i > 0 && schnitt[i]?.uebergang ? schnitt[i].uebergang.dauer : 0);
const schnittDauer = (schnitt) => schnitt.reduce((s, t, i) => s + teilDauer(t) - ueberlappung(schnitt, i), 0);
const eigenesEnde = (schnitt, i) => schnitt[i].bis - ueberlappung(schnitt, i + 1);
function teilAnfaenge(schnitt) {
  let t = 0;
  return schnitt.map((teil, i) => {
    t -= ueberlappung(schnitt, i);
    const anfang = t;
    t += teilDauer(teil);
    return anfang;
  });
}
function imClip(schnitt, zeit) {
  const anfaenge = teilAnfaenge(schnitt);
  for (let i = 0; i < schnitt.length; i++) {
    const ende = i < schnitt.length - 1 ? anfaenge[i + 1] : anfaenge[i] + teilDauer(schnitt[i]);
    if (zeit < ende || i === schnitt.length - 1) {
      return { index: i, clip: schnitt[i].clip, t: Math.min(schnitt[i].bis, Math.max(schnitt[i].von, schnitt[i].von + zeit - anfaenge[i])) };
    }
  }
  return null;
}
function schnittCues(cues, schnitt) {
  const anfaenge = teilAnfaenge(schnitt);
  const ergebnis = [];
  schnitt.forEach((teil, i) => {
    const bis = eigenesEnde(schnitt, i) * 1000;
    cues.forEach((c, index) => {
      if (c.clip !== teil.clip || c.end <= teil.von * 1000 || c.start >= bis) return;
      const start = Math.round(Math.max(c.start, teil.von * 1000) - teil.von * 1000 + anfaenge[i] * 1000);
      const end = Math.round(Math.min(c.end, bis) - teil.von * 1000 + anfaenge[i] * 1000);
      if (end - start >= 200) ergebnis.push({ start, end, text: c.text, index });
    });
  });
  return ergebnis.sort((x, y) => x.start - y.start);
}
// Tonspur (gleiche Rechnung wie in src/schnitt.mjs): null = Ton am Bild, sonst Abschnitte auf der Zeitachse
const tonLaenge = (s) => s.bis - s.von;
const tonEnde = (s) => s.ab + s.bis - s.von;
const r3 = (n) => Math.round(n * 1000) / 1000;
function tonAusSchnitt(schnitt) {
  const anfaenge = teilAnfaenge(schnitt);
  return schnitt.map((t, i) => {
    const s = { quelle: t.clip, von: t.von, bis: t.bis, ab: r3(anfaenge[i]) };
    if (t.lautstaerke !== undefined && t.lautstaerke !== 1) s.lautstaerke = t.lautstaerke;
    if (t.stumm) s.stumm = true;
    if (ueberlappung(schnitt, i)) s.ein = ueberlappung(schnitt, i);
    if (ueberlappung(schnitt, i + 1)) s.aus = ueberlappung(schnitt, i + 1);
    return s;
  });
}
function cuesJeQuelle(cues, tonclips) {
  const je = new Map();
  cues.forEach((c, index) => {
    if (!je.has(c.clip)) je.set(c.clip, []);
    je.get(c.clip).push({ ...c, index });
  });
  for (const t of tonclips) {
    if (je.has(t.id) || !t.sync?.length) continue;
    je.set(t.id, t.sync.flatMap(({ clip, versatz }) => (je.get(clip) ?? []).map((c) => ({ ...c, clip: t.id, start: c.start + versatz * 1000, end: c.end + versatz * 1000 }))));
  }
  return je;
}
function tonCues(cues, spur, tonclips) {
  const je = cuesJeQuelle(cues, tonclips);
  const ergebnis = [];
  for (const s of spur) {
    if (s.stumm || s.lautstaerke === 0) continue;
    for (const c of je.get(s.quelle) ?? []) {
      if (c.end <= s.von * 1000 || c.start >= s.bis * 1000) continue;
      const start = Math.round(Math.max(c.start, s.von * 1000) - s.von * 1000 + s.ab * 1000);
      const end = Math.round(Math.min(c.end, s.bis * 1000) - s.von * 1000 + s.ab * 1000);
      if (end - start >= 200) ergebnis.push({ start, end, text: c.text, index: c.index });
    }
  }
  const gesehen = new Set();
  return ergebnis.sort((x, y) => x.start - y.start).filter((c) => {
    const k = `${c.index}:${Math.round(c.start / 500)}`;
    return gesehen.has(k) ? false : (gesehen.add(k), true);
  });
}
/** Abschnitte auf Zeilen verteilen, damit sich überlappende nicht verdecken. */
function tonZeilen(spur) {
  const enden = [];
  return spur.map((s) => {
    let z = enden.findIndex((e) => e <= s.ab + 0.001);
    if (z < 0) z = enden.length;
    enden[z] = tonEnde(s);
    return z;
  });
}

const zeitGenau = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/**
 * Schnittplatz: Arbeitskopien abspielen, als wäre schon geschnitten; Teile teilen, kürzen, entfernen,
 * verschieben; Clips anhängen; Untertitel im Schnitt bearbeiten. Speichert selbst, meldet Änderungen.
 */
function schnittplatz({ id, a, geaendertMelden, standbildHier, neuLaden, untertitelAn, ton }) {
  const clips = new Map(a.clips.map((c) => [c.id, c]));
  let schnitt = structuredClone(a.schnitt);
  let cues = structuredClone(a.untertitel);
  // Tonspur: null = Ton hängt am Bild; sonst eigenständige Abschnitte (siehe src/schnitt.mjs)
  let tonspur = a.tonspur ? structuredClone(a.tonspur) : null;
  const tonclips = new Map((a.tonclips ?? []).map((t) => [t.id, t]));
  let tonAuswahl = null;
  let ebene = "bild"; // worauf S und Entf wirken: Bild oder Ton
  let auswahl = 0;
  let zeit = 0;
  let aktiv = 0; // Teil, der gerade im Player liegt
  let spielt = false;
  let wechselt = false;
  let aktiverCue = null;
  const verlauf = [];
  const zukunft = [];
  const FPS = 25;

  const video = el("video", { playsinline: true, preload: "auto", class: "schnitt-video" });
  const untertitelZeile = el("div", { class: "schnitt-ut", hidden: true });
  const zeitAnzeige = el("span", { class: "zeit" });
  const hinweis = el("div", { class: "leise", role: "status" });
  const zeitleiste = el("div", { class: "zeitleiste", tabindex: "0", "aria-label": "Zeitleiste – klicken oder ziehen zum Springen" });
  const teileSpur = el("div", { class: "spur-teile" });
  const utSpur = el("div", { class: "spur-ut" });
  const tonSpur = el("div", { class: "spur-ton", "aria-label": "Tonspur" });
  const musikSpur = el("div", { class: "spur-musik" });
  const tonKopf = el("div", { class: "ton-kopf" });
  const abspielkopf = el("div", { class: "abspielkopf" });
  zeitleiste.append(teileSpur, tonSpur, musikSpur, utSpur, abspielkopf);
  const teilInfo = el("div");
  const clipListe = el("div");
  const cueListe = el("ol", { class: "cues" });

  const speichernSchnitt = verzoegert(() => anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { schnitt, tonspur } }).catch((err) => meldung(hinweis, err.message)), 600);
  const speichernCues = verzoegert(() => anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { untertitel: cues } }).catch((err) => meldung(hinweis, err.message)), 800);

  const dauer = () => schnittDauer(schnitt);
  const sagen = (text) => (hinweis.textContent = text);
  const ausCues = () => (tonspur ? tonCues(cues, tonspur, [...tonclips.values()]) : schnittCues(cues, schnitt));
  const spurJetzt = () => tonspur ?? tonAusSchnitt(schnitt);
  const quelleDauer = (q) => clips.get(q)?.dauer ?? tonclips.get(q)?.dauer ?? 0;
  const quelleName = (q) => clips.get(q)?.name ?? tonclips.get(q)?.name ?? q;
  const istAufnahme = (q) => tonclips.has(q);
  const welleUrl = (q) => (istAufnahme(q) ? `/api/auftrag/${id}/tonclip/${q}/welle` : clips.get(q)?.welle ? `/api/auftrag/${id}/clip/${q}/welle` : null);

  // --- Gelöster Ton zum Vorhören: Web Audio spielt die Abschnitte genau wie im fertigen Video ---
  let tonKontext = null;
  const puffer = new Map();
  let laufend = [];
  const kontext = () => (tonKontext ??= new AudioContext());
  function pufferLaden(q) {
    if (!puffer.has(q)) {
      const url = istAufnahme(q) ? `/api/auftrag/${id}/tonclip/${q}/ton` : `/api/auftrag/${id}/clip/${q}/ton`;
      const p = fetch(url).then((r) => {
        if (!r.ok) throw new Error("Ton lässt sich nicht laden.");
        return r.arrayBuffer();
      }).then((b) => kontext().decodeAudioData(b));
      p.catch(() => puffer.delete(q));
      puffer.set(q, p);
    }
    return puffer.get(q);
  }
  const benutzteQuellen = () => [...new Set((tonspur ?? []).filter((x) => !x.stumm).map((x) => x.quelle))].filter((q) => quelleDauer(q));
  function tonStoppen() {
    for (const q of laufend) {
      try {
        q.stop();
      } catch {}
    }
    laufend = [];
  }
  async function tonStarten(ab) {
    tonStoppen();
    if (!tonspur || !spielt) return;
    const ctx = kontext();
    await ctx.resume().catch(() => {});
    const buffer = new Map();
    for (const q of benutzteQuellen()) {
      try {
        buffer.set(q, await pufferLaden(q));
      } catch {}
    }
    if (!spielt) return;
    const t0 = ctx.currentTime + 0.03;
    const ende = dauer();
    for (const x of tonspur) {
      const buf = buffer.get(x.quelle);
      if (!buf || x.stumm || tonEnde(x) <= ab || x.ab >= ende) continue;
      const len = Math.min(tonLaenge(x), ende - x.ab);
      const lokal = Math.max(0, ab - x.ab); // so weit ist der Abschnitt schon
      const start = t0 + Math.max(0, x.ab - ab);
      const v = x.lautstaerke ?? 1;
      const ein = Math.min(x.ein ?? 0, len / 2);
      const aus = Math.min(x.aus ?? 0, len / 2);
      const g = ctx.createGain();
      const pegel = (l) => v * Math.min(1, ein ? l / ein : 1, aus ? (len - l) / aus : 1);
      g.gain.setValueAtTime(pegel(lokal), start);
      if (lokal < ein) g.gain.linearRampToValueAtTime(v, start + ein - lokal);
      if (aus) {
        const ab2 = Math.max(lokal, len - aus);
        g.gain.setValueAtTime(pegel(ab2), start + ab2 - lokal);
        g.gain.linearRampToValueAtTime(0, start + len - lokal);
      }
      const q = ctx.createBufferSource();
      q.buffer = buf;
      q.connect(g).connect(ctx.destination);
      q.start(start, x.von + lokal, len - lokal);
      laufend.push(q);
    }
  }

  // --- Abspielen ---
  async function laden(clipId) {
    if (video.dataset.clip === clipId) return;
    const clip = clips.get(clipId);
    if (!clip?.bereit) throw new Error(`„${clip?.name ?? clipId}“ wird noch vorbereitet.`);
    video.dataset.clip = clipId;
    video.src = `/api/auftrag/${id}/clip/${clipId}/arbeitskopie`;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("Arbeitskopie lässt sich nicht abspielen.")), { once: true });
    });
  }
  /** Lautstärke des Teils im Player (über 100 % hört man erst im fertigen Video). */
  function tonDesTeils() {
    if (tonspur) {
      video.muted = true; // der Ton kommt aus der Tonspur
      return;
    }
    const teil = schnitt[aktiv];
    video.muted = Boolean(teil?.stumm);
    video.volume = Math.min(1, teil?.lautstaerke ?? 1);
  }
  // Hintergrundmusik zum Vorhören (das Leiserwerden unter Sprache gibt es erst im fertigen Video)
  const musik = el("audio", { preload: "auto", loop: true });
  const spielerFlaeche = el("div", { class: "spieler" }, video, untertitelZeile, musik);
  function musikMit(spielen) {
    const m = ton()?.musik;
    if (!m) return musik.pause();
    const src = `/api/auftrag/${id}/musik?n=${encodeURIComponent(m.name)}`;
    if (musik.dataset.src !== src) {
      musik.dataset.src = src;
      musik.src = src;
    }
    musik.volume = Math.min(1, m.lautstaerke ?? 0.25);
    try {
      musik.currentTime = ((m.ab ?? 0) + zeit) % Math.max(1, m.dauer ?? 1);
    } catch {}
    if (spielen) musik.play().catch(() => {});
    else musik.pause();
  }
  async function springe(t) {
    zeit = Math.max(0, Math.min(t, Math.max(0, dauer() - 0.001)));
    const ort = imClip(schnitt, zeit);
    if (!ort) return;
    aktiv = ort.index;
    tonDesTeils();
    try {
      await laden(ort.clip);
      video.currentTime = ort.t;
    } catch (err) {
      sagen(err.message);
    }
    if (!spielt) musikMit(false);
    else if (tonspur) tonStarten(zeit);
    anzeigen();
  }
  async function abspielen() {
    if (spielt) return pause();
    if (zeit >= dauer() - 0.05) await springe(0);
    else await springe(zeit);
    if (tonspur && benutzteQuellen().some((q) => !puffer.has(q))) sagen("🔊 Lade den Ton …");
    if (tonspur) await Promise.all(benutzteQuellen().map((q) => pufferLaden(q).catch(() => {})));
    spielt = true;
    knopfPlay.textContent = "⏸";
    musikMit(true);
    await video.play().catch(() => {});
    tonStarten(zeit);
    requestAnimationFrame(schleife);
  }
  function pause() {
    spielt = false;
    knopfPlay.textContent = "▶";
    video.pause();
    musik.pause();
    tonStoppen();
  }
  /** Übergang im Player andeuten (das echte xfade gibt es im fertigen Video). */
  function uebergangZeigen(u) {
    if (!u) return;
    spielerFlaeche.dataset.uebergang = u.art;
    spielerFlaeche.style.setProperty("--uebergang", `${u.dauer}s`);
    spielerFlaeche.classList.remove("uebergang");
    void spielerFlaeche.offsetWidth; // Animation neu starten
    spielerFlaeche.classList.add("uebergang");
  }

  async function schleife() {
    if (!spielt) return;
    if (!wechselt) {
      const teil = schnitt[aktiv];
      const anfaenge = teilAnfaenge(schnitt);
      const ct = video.currentTime;
      zeit = anfaenge[aktiv] + Math.max(0, ct - teil.von);
      if (ct >= eigenesEnde(schnitt, aktiv) - 0.02 || video.ended) {
        const naechster = schnitt[aktiv + 1];
        if (!naechster) {
          zeit = dauer();
          pause();
        } else if (naechster.clip === teil.clip && Math.abs(naechster.von - teil.bis) < 0.05 && !naechster.uebergang) {
          aktiv++;
          tonDesTeils();
        } else {
          wechselt = true;
          aktiv++;
          tonDesTeils();
          uebergangZeigen(naechster.uebergang);
          try {
            if (tonspur) tonStoppen(); // nach dem Clipwechsel neu ansetzen, damit Bild und Ton zusammenbleiben
            await laden(naechster.clip);
            video.currentTime = naechster.von;
            await video.play();
            if (tonspur) tonStarten(anfaenge[aktiv] ?? zeit);
          } catch (err) {
            sagen(err.message);
            pause();
          }
          wechselt = false;
        }
      }
      anzeigen();
    }
    requestAnimationFrame(schleife);
  }

  // --- Bearbeiten ---
  function aendern(fn, text) {
    verlauf.push(structuredClone({ schnitt, cues, tonspur }));
    if (verlauf.length > 100) verlauf.shift();
    zukunft.length = 0;
    fn();
    nachAenderung(text);
  }
  /** Übergänge gültig halten (wie schnittPruefen auf dem Server): nicht am ersten Teil, höchstens halb so lang wie der kürzere Teil. */
  function uebergaengeBegrenzen() {
    schnitt = schnitt.map((teil, i) => {
      if (!teil.uebergang) return teil;
      const grenze = i === 0 ? 0 : Math.min(2, teilDauer(schnitt[i - 1]) / 2, teilDauer(teil) / 2);
      if (grenze < 0.1) {
        const { uebergang, ...rest } = teil;
        return rest;
      }
      return teil.uebergang.dauer > grenze ? { ...teil, uebergang: { ...teil.uebergang, dauer: Math.floor(grenze * 100) / 100 } } : teil;
    });
  }
  function nachAenderung(text) {
    uebergaengeBegrenzen();
    auswahl = Math.max(0, Math.min(auswahl, schnitt.length - 1));
    if (!tonspur || tonAuswahl >= tonspur.length) tonAuswahl = null;
    if (!tonspur && ebene === "ton") ebene = "bild";
    zeit = Math.min(zeit, Math.max(0, dauer() - 0.001));
    speichernSchnitt();
    speichernCues();
    geaendertMelden();
    zeichnen();
    springe(zeit);
    if (text) sagen(text);
  }
  function rueckgaengig(nach = verlauf, von = zukunft, text = "Rückgängig gemacht.") {
    if (!nach.length) return sagen("Nichts mehr rückgängig zu machen.");
    von.push(structuredClone({ schnitt, cues, tonspur }));
    ({ schnitt, cues, tonspur } = nach.pop());
    nachAenderung(text);
  }
  const wiederholen = () => rueckgaengig(zukunft, verlauf, "Wiederholt.");

  function teilen() {
    const ort = imClip(schnitt, zeit);
    const teil = schnitt[ort.index];
    if (ort.t - teil.von < 0.1 || teil.bis - ort.t < 0.1) return sagen("Zu nah am Rand des Teils – etwas weiter in die Mitte.");
    aendern(() => {
      const hinten = { ...teil, von: ort.t };
      delete hinten.uebergang; // die Blende gehört an den Anfang des vorderen Teils
      schnitt.splice(ort.index, 1, { ...teil, bis: ort.t }, hinten);
      auswahl = ort.index + 1;
    }, "✂️ Geteilt – jetzt z. B. ein Teil auswählen und entfernen.");
  }
  function entfernen(i = auswahl) {
    if (schnitt.length < 2) return sagen("Der letzte Teil bleibt.");
    const anfang = teilAnfaenge(schnitt)[i];
    aendern(() => {
      schnitt.splice(i, 1);
      zeit = anfang;
      auswahl = Math.min(i, schnitt.length - 1);
    }, "🗑️ Teil entfernt.");
  }
  function kuerzen(seite) {
    const ort = imClip(schnitt, zeit);
    const teil = schnitt[ort.index];
    if (seite === "anfang" && teil.bis - ort.t < 0.1) return sagen("Dann bliebe nichts übrig.");
    if (seite === "ende" && ort.t - teil.von < 0.1) return sagen("Dann bliebe nichts übrig.");
    aendern(() => {
      if (seite === "anfang") {
        teil.von = ort.t;
        zeit = teilAnfaenge(schnitt)[ort.index];
      } else {
        teil.bis = ort.t;
      }
      auswahl = ort.index;
    }, seite === "anfang" ? "⇤ Anfang des Teils gekürzt." : "⇥ Ende des Teils gekürzt.");
  }
  function verschieben(richtung) {
    const ziel = auswahl + richtung;
    if (ziel < 0 || ziel >= schnitt.length) return;
    aendern(() => {
      [schnitt[auswahl], schnitt[ziel]] = [schnitt[ziel], schnitt[auswahl]];
      auswahl = ziel;
      zeit = teilAnfaenge(schnitt)[ziel];
    }, "↔ Verschoben.");
  }
  function grenzeSetzen(feld, wert) {
    const teil = schnitt[auswahl];
    const clip = clips.get(teil.clip);
    const v = Math.max(0, Math.min(Number(wert), clip.dauer));
    if (!Number.isFinite(v)) return;
    const neu = { ...teil, [feld]: v };
    if (neu.bis - neu.von < 0.1) return sagen("Ein Teil muss mindestens 0,1 s lang sein.");
    aendern(() => {
      schnitt[auswahl] = neu;
    });
  }
  /** Übergang in Teil i (bzw. "alle"); Dauer höchstens die halbe Länge des kürzeren Teils. */
  function uebergangSetzen(i, u) {
    const setzen = (k) => {
      if (k < 1) return;
      const teil = { ...schnitt[k] };
      if (!u) delete teil.uebergang;
      else {
        const grenze = Math.min(2, teilDauer(schnitt[k - 1]) / 2, teilDauer(teil) / 2);
        if (grenze < 0.1) return;
        teil.uebergang = { art: u.art, dauer: Math.round(Math.min(grenze, Math.max(0.1, u.dauer || 0.5)) * 100) / 100 };
      }
      schnitt[k] = teil;
    };
    aendern(() => {
      if (i === "alle") schnitt.forEach((_, k) => setzen(k));
      else setzen(i);
    }, u ? `⧓ ${optionen.uebergaenge[u.art]}${i === "alle" ? " an allen Schnitten" : ""}.` : "Harter Schnitt.");
  }

  function tonSetzen(felder) {
    aendern(() => {
      const teil = { ...schnitt[auswahl], ...felder };
      if (teil.lautstaerke === 1) delete teil.lautstaerke;
      if (!teil.stumm) delete teil.stumm;
      schnitt[auswahl] = teil;
    }, felder.stumm ? "🔇 Teil stumm." : "🔊 Lautstärke geändert.");
  }
  function ganzAnhaengen(clip) {
    aendern(() => {
      schnitt.push({ clip: clip.id, von: 0, bis: clip.dauer });
      auswahl = schnitt.length - 1;
    }, `„${clip.name}“ ans Ende angehängt.`);
  }

  // --- Untertitel ---
  /** Wo im Ton (Quelle und Zeit) die Abspielposition liegt; bei synchronen Aufnahmen in der Zeit ihres Clips. */
  function tonOrt() {
    if (!tonspur) {
      const o = imClip(schnitt, zeit);
      return { clip: o.clip, t: o.t, bis: schnitt[o.index].bis };
    }
    const x = tonspur.findLast((y) => !y.stumm && y.ab <= zeit && zeit < tonEnde(y));
    if (!x) return null;
    let clip = x.quelle;
    let t = x.von + zeit - x.ab;
    let bis = x.bis;
    const sync = tonclips.get(clip)?.sync;
    if (sync?.length && !cues.some((c) => c.clip === clip)) {
      clip = sync[0].clip;
      t -= sync[0].versatz;
      bis -= sync[0].versatz;
    }
    return { clip, t, bis };
  }
  function cueHier() {
    const ort = tonOrt();
    if (!ort) return sagen("Hier ist kein Ton – Untertitel gehören zu hörbarem Ton.");
    const ende = Math.min(ort.bis, ort.t + 2);
    if (ende - ort.t < 0.3) return sagen("Zu nah am Ende des Teils.");
    aendern(() => {
      cues.push({ clip: ort.clip, start: Math.round(ort.t * 1000), end: Math.round(ende * 1000), text: "Neuer Untertitel" });
      aktiverCue = cues.length - 1;
    }, "💬 Untertitel eingefügt – Text unten eintragen.");
    untertitelAn();
    cueListe.querySelector(`[data-index="${aktiverCue}"] input`)?.select();
  }
  function cueGrenze(seite) {
    if (aktiverCue === null || !cues[aktiverCue]) return sagen("Erst einen Untertitel in der Liste antippen.");
    const ort = tonOrt();
    if (!ort) return sagen("Hier ist kein Ton.");
    const c = cues[aktiverCue];
    if (ort.clip !== c.clip) return sagen("Die Abspielposition liegt in einem anderen Clip als dieser Untertitel.");
    const ms = Math.round(ort.t * 1000);
    if (seite === "start" ? c.end - ms < 200 : ms - c.start < 200) return sagen("Dann wäre der Untertitel zu kurz.");
    aendern(() => {
      cues[aktiverCue] = { ...c, [seite === "start" ? "start" : "end"]: ms };
    });
  }

  // --- Anzeige ---
  function anzeigen() {
    const d = dauer();
    abspielkopf.style.left = `${d ? (zeit / d) * 100 : 0}%`;
    zeitAnzeige.textContent = `${zeitGenau(zeit)} / ${zeitGenau(d)}`;
    const ms = zeit * 1000;
    const jetzt = ausCues().find((c) => ms >= c.start && ms < c.end);
    untertitelZeile.hidden = !jetzt;
    untertitelZeile.textContent = jetzt?.text ?? "";
    for (const li of cueListe.children) li.classList.toggle("jetzt", Number(li.dataset.index) === jetzt?.index);
  }

  function zeichnen() {
    const d = dauer() || 1;
    ersetzen(teileSpur, ...schnitt.map((teil, i) => {
      const clip = clips.get(teil.clip);
      const td = teilDauer(teil);
      const breite = `${(clip.dauer / td) * 100}%`;
      const links = `${(-teil.von / td) * 100}%`;
      return el("div", {
        class: `teil${i === auswahl && ebene === "bild" ? " gewaehlt" : ""}`, style: { flexGrow: String(td) },
        title: `${clip.name}: ${zeitGenau(teil.von)}–${zeitGenau(teil.bis)}${teil.uebergang ? ` · ${optionen.uebergaenge[teil.uebergang.art]} ${teil.uebergang.dauer} s` : ""}`,
      },
      teil.uebergang ? el("span", { class: "uebergang-marke", "aria-hidden": "true" }, "⧓") : null,
      clip.bereit && clip.bilder ? el("img", { class: "streifen", src: `/api/auftrag/${id}/clip/${clip.id}/streifen`, alt: "", draggable: "false", style: { width: breite, left: links } }) : el("span", { class: "leise" }, "wird vorbereitet …"),
      el("span", { class: "teil-name" }, `${teil.stumm ? "🔇 " : teil.lautstaerke !== undefined && teil.lautstaerke !== 1 ? `🔊${Math.round(teil.lautstaerke * 100)} % ` : ""}${clips.size > 1 ? clip.name : i + 1}`));
    }));
    zeichnenTon();
    const aus = ausCues();
    ersetzen(utSpur, ...aus.map((c) => el("div", {
      class: "ut-block", title: c.text,
      style: { left: `${(c.start / 1000 / d) * 100}%`, width: `${((c.end - c.start) / 1000 / d) * 100}%` },
    })));
    const teil = schnitt[auswahl];
    const clip = clips.get(teil.clip);
    const zahl = (feld) => el("input", { type: "number", step: "0.1", min: "0", max: String(clip.dauer.toFixed(1)), value: teil[feld].toFixed(2), "aria-label": feld === "von" ? "Anfang im Clip (Sekunden)" : "Ende im Clip (Sekunden)", onchange: (ev) => grenzeSetzen(feld, ev.target.value) });
    ersetzen(teilInfo, 
      el("strong", {}, `Teil ${auswahl + 1} von ${schnitt.length}`), " · ", clip.name,
      el("div", { class: "reihe zahlen" }, el("label", { class: "zeile" }, "von", zahl("von")), el("label", { class: "zeile" }, "bis", zahl("bis")), el("span", { class: "leise" }, `s im Clip (${zeitGenau(clip.dauer)})`)),
      auswahl > 0 ? el("div", { class: "reihe uebergang-wahl" },
        el("label", { class: "zeile" }, "Übergang vom vorigen Teil",
          el("select", { "aria-label": "Übergang vom vorigen Teil", onchange: (ev) => uebergangSetzen(auswahl, ev.target.value === "hart" ? null : { art: ev.target.value, dauer: teil.uebergang?.dauer ?? 0.5 }) },
            Object.entries(optionen.uebergaenge).map(([art, titel]) => el("option", { value: art, selected: (teil.uebergang?.art ?? "hart") === art }, titel)))),
        teil.uebergang ? el("label", { class: "zeile" },
          el("input", { type: "number", min: "0.1", max: "2", step: "0.1", value: String(teil.uebergang.dauer), "aria-label": "Dauer des Übergangs in Sekunden",
            onchange: (ev) => uebergangSetzen(auswahl, { ...teil.uebergang, dauer: Number(ev.target.value) }) }), "s") : null,
        schnitt.length > 2 ? el("button", { type: "button", class: "zweit klein", title: "Diesen Übergang an allen Schnitten verwenden", onclick: () => uebergangSetzen("alle", teil.uebergang ?? null) }, "für alle Schnitte") : null) : null,
      tonspur ? el("p", { class: "leise" }, "🔓 Der Ton ist vom Bild gelöst – Lautstärke und Blenden unten in der Tonspur.") : el("div", { class: "reihe ton-teil" },
        el("label", { class: "zeile" }, "🔊",
          el("input", { type: "range", min: "0", max: "200", step: "5", value: String(Math.round((teil.lautstaerke ?? 1) * 100)), "aria-label": "Lautstärke dieses Teils",
            disabled: Boolean(teil.stumm), oninput: (ev) => (ev.target.nextSibling.textContent = `${ev.target.value} %`), onchange: (ev) => tonSetzen({ lautstaerke: Number(ev.target.value) / 100 }) }),
          el("span", { class: "leise" }, `${Math.round((teil.lautstaerke ?? 1) * 100)} %`)),
        el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: Boolean(teil.stumm), onchange: (ev) => tonSetzen({ stumm: ev.target.checked }) }), "stumm")),
      el("div", { class: "reihe" },
        el("button", { type: "button", class: "zweit klein", onclick: () => verschieben(-1), disabled: auswahl === 0 }, "◀ früher"),
        el("button", { type: "button", class: "zweit klein", onclick: () => verschieben(1), disabled: auswahl === schnitt.length - 1 }, "später ▶"),
        el("button", { type: "button", class: "zweit klein", onclick: () => entfernen(), disabled: schnitt.length < 2 }, "🗑️ Teil entfernen")));
    if (ebene === "ton" && tonspur && tonAuswahl !== null) ersetzen(teilInfo, ...tonInfo());
    ersetzen(clipListe, 
      el("strong", {}, "Clips"),
      el("ul", { class: "clipliste" }, [...clips.values()].map((c) => el("li", {},
        el("span", {}, `${c.name} · ${zeitGenau(c.dauer)}${c.bereit ? "" : " · wird vorbereitet"}`),
        el("span", { class: "reihe" },
          el("button", { type: "button", class: "zweit klein", title: "Ganzen Clip ans Ende hängen", onclick: () => ganzAnhaengen(c) }, "+ anhängen"),
          clips.size > 1 ? el("button", { type: "button", class: "zweit klein", title: "Clip aus dem Projekt löschen", onclick: async () => {
            if (!confirm(`„${c.name}“ aus dem Projekt löschen?`)) return;
            try {
              await anfrage(`auftrag/${id}/clip/${c.id}/entfernen`, { methode: "POST" });
              neuLaden();
            } catch (err) {
              sagen(err.message);
            }
          } }, "✕") : null)))),
      clipHochladen,
      el("strong", {}, "Tonaufnahmen"),
      tonclips.size ? el("ul", { class: "clipliste" }, [...tonclips.values()].map((t) => el("li", {},
        el("span", {}, `🎙️ ${t.name} · ${zeitGenau(t.dauer)} · `,
          t.sync.length ? el("span", { class: "gut", title: t.sync.map((x) => `${quelleName(x.clip)}: ${x.versatz.toFixed(2)} s (Güte ${x.guete})`).join("\n") }, `🎯 synchron zu ${t.sync.map((x) => quelleName(x.clip)).join(", ")}`) : el("span", { class: "leise" }, "nicht ausgerichtet")),
        el("span", { class: "reihe" },
          el("button", { type: "button", class: "zweit klein", title: "Ganze Aufnahme an der Abspielposition in die Tonspur legen", onclick: () => tonEinfuegen(t.id) }, "+ hier"),
          el("button", { type: "button", class: "zweit klein", title: "Passende Stelle in den Clips suchen und dort den Kamera-Ton ersetzen", onclick: () => tonclipAktion(t, "ausrichten") }, "🎯"),
          el("button", { type: "button", class: "zweit klein", title: "Aufnahme aus dem Projekt löschen", onclick: () => confirm(`„${t.name}“ löschen?`) && tonclipAktion(t, "entfernen") }, "✕"))))) : null,
      tonHochladen);
    ersetzen(cueListe, ...aus.map((c) => {
      const eingabe = el("input", { type: "text", maxlength: 300, "aria-label": `Untertitel ab ${zeitGenau(c.start / 1000)}`, oninput: () => {
        cues[c.index] = { ...cues[c.index], text: eingabe.value };
        speichernCues();
        geaendertMelden();
        utSpur.children[aus.indexOf(c)]?.setAttribute("title", eingabe.value);
      }, onfocus: () => {
        aktiverCue = c.index;
        markieren();
      } });
      eingabe.value = c.text;
      return el("li", { "data-index": String(c.index), class: c.index === aktiverCue ? "aktiv" : "" },
        el("button", { type: "button", class: "zweit klein zeitknopf", title: "Hierhin springen", onclick: () => {
          aktiverCue = c.index;
          markieren();
          springe(c.start / 1000 + 0.01);
        } }, zeitGenau(c.start / 1000)),
        eingabe,
        el("button", { type: "button", class: "zweit klein", title: "Untertitel löschen", "aria-label": "Untertitel löschen", onclick: () => aendern(() => {
          cues.splice(c.index, 1);
          aktiverCue = null;
        }, "Untertitel gelöscht.") }, "✕"));
    }));
    anzeigen();
  }
  function markieren() {
    for (const li of cueListe.children) li.classList.toggle("aktiv", Number(li.dataset.index) === aktiverCue);
  }

  // --- Tonspur ---
  const ZEILE = 38; // Höhe einer Zeile der Tonspur in px
  function abschnittStil(elem, x, d) {
    const len = tonLaenge(x);
    elem.style.left = `${(x.ab / d) * 100}%`;
    elem.style.width = `${(len / d) * 100}%`;
    const bild = elem.querySelector(".welle");
    if (bild) {
      bild.style.width = `${((quelleDauer(x.quelle) || len) / len) * 100}%`;
      bild.style.left = `${(-x.von / len) * 100}%`;
    }
    for (const [cls, feld] of [["ein", "ein"], ["aus", "aus"]]) {
      const b = elem.querySelector(`.blende.${cls}`);
      if (b) b.style.width = `${((x[feld] ?? 0) / len) * 100}%`;
    }
  }
  function zeichnenTon() {
    const d = dauer() || 1;
    const spur = spurJetzt();
    const reihenfolge = spur.map((x, i) => i).sort((p, q) => spur[p].ab - spur[q].ab);
    const zeilenSortiert = tonZeilen(reihenfolge.map((i) => spur[i]));
    const zeilen = [];
    reihenfolge.forEach((i, k) => (zeilen[i] = zeilenSortiert[k]));
    tonSpur.style.height = `${Math.max(1, ...zeilen.map((z) => z + 1)) * ZEILE}px`;
    tonSpur.classList.toggle("gekoppelt", !tonspur);
    ersetzen(tonSpur, ...spur.map((x, i) => {
      const len = tonLaenge(x);
      const w = welleUrl(x.quelle);
      const elem = el("div", {
        class: `ton-abschnitt${istAufnahme(x.quelle) ? " aufnahme" : ""}${x.stumm ? " stumm" : ""}${tonspur && ebene === "ton" && tonAuswahl === i ? " gewaehlt" : ""}`,
        style: { top: `${zeilen[i] * ZEILE}px` },
        title: `${quelleName(x.quelle)}: ${zeitGenau(x.von)}–${zeitGenau(x.bis)} · im Video ab ${zeitGenau(x.ab)}${tonspur ? " – ziehen zum Verschieben, Ränder zum Kürzen, mit Alt den Inhalt verschieben" : " – ziehen löst den Ton vom Bild"}`,
        onpointerdown: (ev) => tonZiehen(ev, i, "mitte"),
      },
      w ? el("img", { class: "welle", src: w, alt: "", draggable: "false" }) : el("span", { class: "leise" }, "kein Bild der Welle"),
      el("span", { class: "blende ein" }), el("span", { class: "blende aus" }),
      el("span", { class: "ton-name" }, `${x.stumm ? "🔇 " : ""}${x.lautstaerke !== undefined && x.lautstaerke !== 1 ? `${Math.round(x.lautstaerke * 100)} % · ` : ""}${istAufnahme(x.quelle) ? "🎙️ " : ""}${quelleName(x.quelle)}`),
      tonspur ? el("span", { class: "griff links", onpointerdown: (ev) => tonZiehen(ev, i, "links") }) : null,
      tonspur ? el("span", { class: "griff rechts", onpointerdown: (ev) => tonZiehen(ev, i, "rechts") }) : null);
      abschnittStil(elem, x, d);
      return elem;
    }));
    const m = ton()?.musik;
    musikSpur.hidden = !m;
    if (m) ersetzen(musikSpur, el("div", { class: "musik-balken", title: `Hintergrundmusik: ${m.name} – Einstellungen unter „Ton“` }, `🎵 ${m.name} · ${Math.round((m.lautstaerke ?? 0.25) * 100)} %${m.ducking !== false ? " · leiser unter Sprache" : ""}`));
    ersetzen(tonKopf,
      el("strong", {}, "🔊 Ton"),
      tonspur
        ? el("span", { class: "leise" }, "eigenständig – Schnitte im Bild ändern ihn nicht")
        : el("span", { class: "leise" }, "hängt am Bild – jeder Teil bringt seinen Ton mit"),
      tonspur
        ? knopf("🔗 Wieder ans Bild koppeln", "Tonspur verwerfen, der Ton folgt wieder dem Bild", tonKoppeln)
        : knopf("🔓 Ton vom Bild lösen", "Ton eigenständig schneiden: verschieben, J-/L-Schnitte, Blenden, eigene Aufnahmen", tonLoesen),
      knopf("🎙️ Tonaufnahme dazu", "Z. B. vom Ansteckmikrofon – der Bot sucht die passende Stelle selbst", () => tonDatei.click()));
  }
  function tonInfo() {
    const x = tonspur[tonAuswahl];
    const zahl = (feld, label, max) => el("label", { class: "zeile" }, label,
      el("input", { type: "number", step: "0.1", min: "0", max: String(max), value: (x[feld] ?? 0).toFixed(2), "aria-label": label,
        onchange: (ev) => abschnittAendern(feld, Number(ev.target.value)) }));
    return [
      el("strong", {}, `Tonabschnitt ${tonAuswahl + 1} von ${tonspur.length}`), " · ", istAufnahme(x.quelle) ? "🎙️ " : "", quelleName(x.quelle),
      el("div", { class: "reihe zahlen" }, zahl("ab", "im Video ab", dauer()), el("span", { class: "leise" }, "s")),
      el("div", { class: "reihe zahlen" }, zahl("von", "aus der Quelle von", quelleDauer(x.quelle)), zahl("bis", "bis", quelleDauer(x.quelle)), el("span", { class: "leise" }, `s (${zeitGenau(quelleDauer(x.quelle))})`)),
      el("div", { class: "reihe zahlen" }, zahl("ein", "Einblenden", 5), zahl("aus", "Ausblenden", 5), el("span", { class: "leise" }, "s")),
      el("div", { class: "reihe ton-teil" },
        el("label", { class: "zeile" }, "🔊",
          el("input", { type: "range", min: "0", max: "200", step: "5", value: String(Math.round((x.lautstaerke ?? 1) * 100)), "aria-label": "Lautstärke dieses Abschnitts",
            disabled: Boolean(x.stumm), oninput: (ev) => (ev.target.nextSibling.textContent = `${ev.target.value} %`), onchange: (ev) => abschnittAendern("lautstaerke", Number(ev.target.value) / 100) }),
          el("span", { class: "leise" }, `${Math.round((x.lautstaerke ?? 1) * 100)} %`)),
        el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: Boolean(x.stumm), onchange: (ev) => abschnittAendern("stumm", ev.target.checked) }), "stumm")),
      el("div", { class: "reihe" },
        knopf("✂️ Teilen", "Abschnitt an der Abspielposition teilen (S)", tonTeilen),
        knopf("⇥ Hierher", "Abschnitt beginnt an der Abspielposition", () => abschnittAendern("ab", zeit)),
        knopf("🗑️", "Abschnitt entfernen (Entf)", tonEntfernen),
        knopf("🎞️ Zum Bild", "Wieder die Teile des Bildes bearbeiten", () => {
          ebene = "bild";
          zeichnen();
        })),
    ];
  }
  function tonLoesen() {
    aendern(() => {
      tonspur = tonAusSchnitt(schnitt);
      ebene = "ton";
      tonAuswahl = Math.min(auswahl, tonspur.length - 1);
    }, "🔓 Ton gelöst – Abschnitte ziehen, an den Rändern kürzen, S teilt, Entf entfernt.");
  }
  function tonKoppeln() {
    if (!confirm("Ton wieder ans Bild koppeln? Die eigene Tonspur (Verschiebungen, Blenden, Aufnahmen darin) geht verloren – Rückgängig geht.")) return;
    aendern(() => {
      tonspur = null;
      tonAuswahl = null;
      ebene = "bild";
    }, "🔗 Ton folgt wieder dem Bild.");
  }
  /** Der Abschnitt an der Abspielposition: der gewählte, wenn er dort liegt, sonst der oberste. */
  function abschnittHier() {
    if (!tonspur) return null;
    const passt = (i) => tonspur[i] && tonspur[i].ab <= zeit && zeit < tonEnde(tonspur[i]);
    if (tonAuswahl !== null && passt(tonAuswahl)) return tonAuswahl;
    const i = tonspur.findLastIndex((_, k) => passt(k));
    return i < 0 ? null : i;
  }
  function tonTeilen() {
    const i = abschnittHier();
    if (i === null) return sagen("An der Abspielposition liegt kein Tonabschnitt.");
    const x = tonspur[i];
    const lokal = zeit - x.ab;
    if (lokal < 0.1 || tonLaenge(x) - lokal < 0.1) return sagen("Zu nah am Rand des Abschnitts.");
    aendern(() => {
      const vorne = { ...x, bis: r3(x.von + lokal) };
      delete vorne.aus;
      const hinten = { ...x, von: r3(x.von + lokal), ab: r3(zeit) };
      delete hinten.ein;
      tonspur.splice(i, 1, vorne, hinten);
      tonAuswahl = i + 1;
      ebene = "ton";
    }, "✂️ Ton geteilt.");
  }
  function tonEntfernen() {
    const i = tonAuswahl ?? abschnittHier();
    if (i === null) return sagen("Erst einen Tonabschnitt antippen.");
    aendern(() => {
      tonspur.splice(i, 1);
      tonAuswahl = null;
    }, "🗑️ Tonabschnitt entfernt.");
  }
  function abschnittAendern(feld, wert) {
    const x = { ...tonspur[tonAuswahl] };
    const q = quelleDauer(x.quelle);
    if (feld === "stumm") x.stumm = wert;
    else if (!Number.isFinite(wert)) return;
    else if (feld === "lautstaerke") x.lautstaerke = Math.max(0, Math.min(2, wert));
    else if (feld === "ab") x.ab = r3(Math.max(0, Math.min(wert, dauer() - 0.1)));
    else if (feld === "von") x.von = r3(Math.max(0, Math.min(wert, x.bis - 0.1)));
    else if (feld === "bis") x.bis = r3(Math.min(q, Math.max(wert, x.von + 0.1)));
    else x[feld] = Math.round(Math.max(0, Math.min(5, wert, tonLaenge(x) / 2)) * 100) / 100;
    for (const f of ["ein", "aus"]) if (x[f] !== undefined) x[f] = Math.min(x[f], tonLaenge(x) / 2);
    if (x.lautstaerke === 1) delete x.lautstaerke;
    if (!x.stumm) delete x.stumm;
    for (const f of ["ein", "aus"]) if (!x[f]) delete x[f];
    aendern(() => (tonspur[tonAuswahl] = x), feld === "stumm" ? (wert ? "🔇 Abschnitt stumm." : "🔊 Abschnitt wieder hörbar.") : null);
  }
  function tonEinfuegen(q) {
    aendern(() => {
      tonspur ??= tonAusSchnitt(schnitt);
      tonspur.push({ quelle: q, von: 0, bis: r3(quelleDauer(q)), ab: r3(Math.min(zeit, dauer() - 0.1)) });
      tonAuswahl = tonspur.length - 1;
      ebene = "ton";
    }, `🎙️ „${quelleName(q)}“ ab ${zeitGenau(zeit)} in die Tonspur gelegt.`);
  }
  async function tonclipAktion(t, aktion) {
    sagen(aktion === "ausrichten" ? "🎯 Suche die passende Stelle …" : "Lösche …");
    try {
      await sichern();
      const antwort = await anfrage(`auftrag/${id}/tonclip/${t.id}/${aktion}`, { methode: "POST" });
      neuLaden(antwort.meldung);
    } catch (err) {
      sagen(err.message);
    }
  }
  /** Ziehen in der Tonspur: Mitte verschiebt (mit Alt den Inhalt), Ränder kürzen; rastet an Schnitten und Abspielposition ein. */
  function tonZiehen(ev, i, art) {
    ev.stopPropagation();
    ev.preventDefault();
    if (spielt) pause();
    const elem = ev.currentTarget.closest(".ton-abschnitt");
    elem.setPointerCapture(ev.pointerId);
    const breite = tonSpur.getBoundingClientRect().width;
    const proPx = dauer() / breite;
    const x0 = ev.clientX;
    const start = { ...spurJetzt()[i] };
    let vorher = null;
    const kanten = () => [0, dauer(), zeit, ...teilAnfaenge(schnitt), ...tonspur.flatMap((x, k) => (k === i ? [] : [x.ab, tonEnde(x)]))];
    const fang = (t) => {
      let beste = t;
      let abstand = 6 * proPx;
      for (const k of kanten()) if (Math.abs(k - t) < abstand) [abstand, beste] = [Math.abs(k - t), k];
      return beste;
    };
    const bewegen = (e2) => {
      if (!vorher) {
        if (Math.abs(e2.clientX - x0) < 3) return;
        vorher = structuredClone({ schnitt, cues, tonspur });
        if (!tonspur) {
          tonspur = tonAusSchnitt(schnitt);
          sagen("🔓 Ton vom Bild gelöst – Schnitte im Bild ändern den Ton jetzt nicht mehr.");
        }
      }
      const dt = (e2.clientX - x0) * proPx;
      const q = quelleDauer(start.quelle);
      const x = { ...start };
      if (art === "mitte" && e2.altKey) {
        const d = Math.max(-start.von, Math.min(q - start.bis, -dt));
        x.von = start.von + d;
        x.bis = start.bis + d;
      } else if (art === "mitte") {
        const ab = Math.max(0, start.ab + dt);
        const vorn = fang(ab);
        const hinten = fang(ab + tonLaenge(x)) - tonLaenge(x);
        x.ab = Math.max(0, Math.min(Math.abs(vorn - ab) <= Math.abs(hinten - ab) ? vorn : hinten, dauer() - 0.1));
      } else if (art === "links") {
        const d = Math.max(-start.von, -start.ab, Math.min(fang(start.ab + dt) - start.ab, tonLaenge(start) - 0.1));
        x.von = start.von + d;
        x.ab = start.ab + d;
      } else {
        const d = Math.min(q - start.bis, Math.max(fang(tonEnde(start) + dt) - tonEnde(start), 0.1 - tonLaenge(start)));
        x.bis = start.bis + d;
      }
      for (const f of ["von", "bis", "ab"]) x[f] = r3(x[f]);
      for (const f of ["ein", "aus"]) if (x[f]) x[f] = Math.min(x[f], tonLaenge(x) / 2);
      tonspur[i] = x;
      abschnittStil(elem, x, dauer() || 1);
      sagen(`${quelleName(x.quelle)}: im Video ${zeitGenau(x.ab)}–${zeitGenau(tonEnde(x))} · aus der Quelle ${zeitGenau(x.von)}–${zeitGenau(x.bis)}`);
    };
    const loslassen = (e2) => {
      elem.removeEventListener("pointermove", bewegen);
      elem.removeEventListener("pointerup", loslassen);
      elem.removeEventListener("pointercancel", loslassen);
      if (!vorher) {
        // Nur angetippt: auswählen und hinspringen
        const t = zeitAus(e2);
        if (tonspur) {
          tonAuswahl = i;
          ebene = "ton";
        } else {
          auswahl = imClip(schnitt, t).index;
        }
        zeichnen();
        return springe(t);
      }
      verlauf.push(vorher);
      if (verlauf.length > 100) verlauf.shift();
      zukunft.length = 0;
      tonAuswahl = i;
      ebene = "ton";
      nachAenderung(art === "mitte" ? (e2.altKey ? "↔ Inhalt verschoben." : "↔ Ton verschoben.") : "⇤⇥ Ton gekürzt.");
    };
    elem.addEventListener("pointermove", bewegen);
    elem.addEventListener("pointerup", loslassen);
    elem.addEventListener("pointercancel", loslassen);
  }

  // Eigene Tonaufnahme hochladen (z. B. Ansteckmikrofon)
  const tonFortschritt = el("div", { class: "fortschritt", hidden: true }, el("div"));
  const tonDatei = el("input", { type: "file", accept: "audio/*", class: "unsichtbar", id: "ton-datei", onchange: async () => {
    const f = tonDatei.files[0];
    if (!f) return;
    tonFortschritt.hidden = false;
    sagen("⏳ Lade die Aufnahme hoch und suche die passende Stelle in den Clips …");
    try {
      await sichern();
      const antwort = await hochladen(`auftrag/${id}/tonclip?name=${encodeURIComponent(f.name)}`, f, (p) => (tonFortschritt.firstChild.style.width = `${Math.round(p * 100)}%`));
      neuLaden(antwort.meldung);
    } catch (err) {
      sagen(err.message);
      tonFortschritt.hidden = true;
    }
  } });
  const tonHochladen = el("div", {}, el("label", { for: "ton-datei", class: "knopf zweit klein", tabindex: "0" }, "🎙️ Tonaufnahme hochladen"), tonDatei, tonFortschritt);

  // Weiteren Clip hochladen
  const clipFortschritt = el("div", { class: "fortschritt", hidden: true }, el("div"));
  const clipDatei = el("input", { type: "file", accept: "video/*", class: "unsichtbar", id: "clip-datei", onchange: async () => {
    const f = clipDatei.files[0];
    if (!f) return;
    clipFortschritt.hidden = false;
    try {
      await sichern(); // Ungespeicherte Schnitte nicht verlieren, wenn gleich neu geladen wird
      await hochladen(`auftrag/${id}/clip?name=${encodeURIComponent(f.name)}`, f, (p) => (clipFortschritt.firstChild.style.width = `${Math.round(p * 100)}%`));
      neuLaden();
    } catch (err) {
      sagen(err.message);
      clipFortschritt.hidden = true;
    }
  } });
  const clipHochladen = el("div", {}, el("label", { for: "clip-datei", class: "knopf zweit klein", tabindex: "0" }, "＋ Weiteren Clip hochladen"), clipDatei, clipFortschritt);

  // --- Bedienung ---
  const knopf = (text, titel, fn, cls = "zweit klein") => el("button", { type: "button", class: cls, title: titel, "aria-label": titel, onclick: fn }, text);
  const knopfPlay = knopf("▶", "Abspielen/Pause (Leertaste)", abspielen, "klein");
  const werkzeuge = el("div", { class: "werkzeuge" },
    knopf("⏮", "Zum Anfang", () => springe(0)),
    knopf("◀︎|", "Ein Bild zurück (←)", () => springe(zeit - 1 / FPS)),
    knopfPlay,
    knopf("|▶︎", "Ein Bild vor (→)", () => springe(zeit + 1 / FPS)),
    zeitAnzeige,
    knopf("✂️ Teilen", "Teil an der Abspielposition teilen (S)", teilen),
    knopf("⇤ Anfang hier", "Anfang des Teils auf die Abspielposition setzen (I)", () => kuerzen("anfang")),
    knopf("Ende hier ⇥", "Ende des Teils auf die Abspielposition setzen (O)", () => kuerzen("ende")),
    knopf("🗑️", "Ausgewählten Teil entfernen (Entf)", () => entfernen()),
    knopf("↶", "Rückgängig (Strg+Z)", () => rueckgaengig()),
    knopf("↷", "Wiederholen (Strg+Y)", wiederholen),
    knopf("🖼️ Standbild hier", "Standbild mit Logo, Untertiteln und Bauchbinde an dieser Stelle", () => standbildHier(zeit)));

  // Zeitleiste: klicken oder ziehen
  let zieht = false;
  const zeitAus = (ev) => {
    const r = zeitleiste.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dauer();
  };
  zeitleiste.addEventListener("pointerdown", (ev) => {
    zieht = true;
    zeitleiste.setPointerCapture(ev.pointerId);
    if (spielt) pause();
    const t = zeitAus(ev);
    if (tonspur && tonSpur.contains(ev.target)) {
      ebene = "ton";
      tonAuswahl = null;
    } else {
      ebene = "bild";
      auswahl = imClip(schnitt, t).index;
    }
    zeichnen();
    springe(t);
  });
  zeitleiste.addEventListener("pointermove", (ev) => zieht && springe(zeitAus(ev)));
  zeitleiste.addEventListener("pointerup", () => (zieht = false));

  const tasten = (ev) => {
    if (!document.body.contains(zeitleiste)) return document.removeEventListener("keydown", tasten);
    if (ev.target.closest("input, textarea, select, [contenteditable]")) return;
    const strg = ev.ctrlKey || ev.metaKey;
    const t = ev.key.toLowerCase();
    const aktionen = {
      " ": abspielen, s: () => (ebene === "ton" && tonspur ? tonTeilen() : teilen()), i: () => kuerzen("anfang"), o: () => kuerzen("ende"),
      delete: () => (ebene === "ton" && tonspur ? tonEntfernen() : entfernen()), backspace: () => (ebene === "ton" && tonspur ? tonEntfernen() : entfernen()),
      arrowleft: () => springe(zeit - (ev.shiftKey ? 1 : 1 / FPS)), arrowright: () => springe(zeit + (ev.shiftKey ? 1 : 1 / FPS)),
      home: () => springe(0), end: () => springe(dauer() - 0.01),
    };
    if (strg && t === "z") aktionen.x = ev.shiftKey ? wiederholen : () => rueckgaengig();
    else if (strg && t === "y") aktionen.x = wiederholen;
    const fn = strg ? aktionen.x : aktionen[t];
    if (!fn) return;
    ev.preventDefault();
    fn();
  };
  document.addEventListener("keydown", tasten);

  const element = el("section", { class: "karte schnittplatz", "aria-label": "Schnitt" },
    el("h2", {}, "✂️ Schnitt"),
    el("div", { class: "schnitt-oben" },
      spielerFlaeche,
      el("div", { class: "schnitt-seite" }, teilInfo, clipListe)),
    werkzeuge, tonKopf, zeitleiste, hinweis,
    el("p", { class: "leise tasten" }, "Tasten: Leertaste abspielen · ← → ein Bild (mit Umschalt: 1 s) · S teilen · I/O Anfang/Ende hier · Entf entfernen · Strg+Z rückgängig – S und Entf wirken auf Bild oder Ton, je nachdem, was zuletzt angetippt wurde"),
    el("details", { class: "ut-bearbeiten", open: cues.length > 0 },
      el("summary", {}, "Untertitel bearbeiten"),
      el("div", { class: "reihe" },
        knopf("💬 Untertitel hier einfügen", "Neuer Untertitel an der Abspielposition", cueHier),
        knopf("⇤ Beginn hier", "Ausgewählter Untertitel beginnt an der Abspielposition", () => cueGrenze("start")),
        knopf("Ende hier ⇥", "Ausgewählter Untertitel endet an der Abspielposition", () => cueGrenze("ende"))),
      cueListe));
  zeichnen();
  springe(0);
  async function sichern() {
    await Promise.all([speichernSchnitt.jetzt(), speichernCues.jetzt()]);
  }
  return { element, stand: () => ({ schnitt, tonspur, untertitel: cues }), sichern, sagen };
}

// ---------- Editor ----------

async function editor(id) {
  let a = await anfrage(`auftrag/${id}`);
  let e = structuredClone(a.e);
  const istVideo = a.art === "video";

  const vorschau = el("div", { class: "vorschau" }, el("p", { class: "leise" }, "Vorschau lädt …"));
  const vorschauInfo = el("div", { class: "leise" });
  const status = el("div");
  const aktionen = el("div");
  const formular = el("div", { class: "karte" });
  const fassungWahl = el("div");
  const seitenleiste = el("div", { class: "vorschau-spalte" }, el("div", { class: "karte" }, fassungWahl, vorschau, vorschauInfo, status, aktionen));
  const oben = el("div");
  let platz = null;
  let standbildZeit = null;
  ersetzen(app, oben, el("div", { class: "editor" }, formular, seitenleiste));

  // --- Speichern und Vorschau ---
  const speichern = verzoegert(async () => {
    try {
      a = await anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { e } });
      zeigeAktionen();
    } catch {}
  }, 800);

  let vorschauNr = 0;
  let vorschauUrl = null;
  const bildZeigen = (blob, hinweis) => {
    if (vorschauUrl) URL.revokeObjectURL(vorschauUrl);
    vorschauUrl = URL.createObjectURL(blob);
    ersetzen(vorschau, el("img", { src: vorschauUrl, alt: "Vorschau" }), ...(hinweis ? [el("span", { class: "hinweis" }, hinweis)] : []));
  };
  const vorschauLaden = verzoegert(async () => {
    if (istVideo && (!a.quelle || a.status === "arbeitet")) return;
    const nr = ++vorschauNr;
    vorschau.classList.add("arbeitet");
    try {
      const res = await anfrage(`auftrag/${id}/vorschau`, { methode: "POST", json: { e, zeit: standbildZeit }, roh: true });
      const blob = await res.blob();
      if (nr !== vorschauNr) return;
      const lage = res.headers.get("X-Lage");
      bildZeigen(blob, istVideo ? `Standbild${standbildZeit !== null ? ` bei ${zeitGenau(standbildZeit)}` : ""}${e.untertitel && lage ? ` · Untertitel ${{ unten: "unten", mitte: "Mitte", oben: "oben", "unter-bild": "unter dem Bild" }[lage]}${e.untertitelLage === "auto" ? " (automatisch)" : ""}` : ""}` : null);
    } catch (err) {
      if (nr === vorschauNr && err.name !== "AbortError") ersetzen(vorschau, el("p", { class: "fehler" }, err.message));
    } finally {
      if (nr === vorschauNr) vorschau.classList.remove("arbeitet");
    }
  }, istVideo ? 1200 : 350);

  const beiAenderung = []; // Teile des Formulars, die von anderen Einstellungen abhängen
  const geaendert = () => {
    beiAenderung.forEach((f) => f());
    a.geaendert = true;
    speichern();
    vorschauLaden();
    zeigeAktionen();
  };
  const setze = (feld, wert) => {
    e[feld] = wert;
    geaendert();
  };

  // --- Bausteine ---
  const auswahl = (feld, eintraege, label) => {
    const s = el("select", { id: `f-${feld}`, onchange: () => setze(feld, s.value) },
      eintraege.map(([wert, text]) => el("option", { value: wert, selected: e[feld] === wert }, text)));
    return [el("label", { for: `f-${feld}` }, label), s];
  };
  const haken = (feld, text, nachher) => el("label", { class: "zeile" },
    el("input", { type: "checkbox", checked: e[feld], onchange: (ev) => { setze(feld, ev.target.checked); nachher?.(); } }), text);
  const textfeld = (feld, label, { mehrzeilig = false, max = 300 } = {}) => {
    const f = el(mehrzeilig ? "textarea" : "input", { id: `f-${feld}`, type: mehrzeilig ? undefined : "text", maxlength: max, oninput: () => setze(feld, f.value) });
    f.value = e[feld] ?? "";
    return [el("label", { for: `f-${feld}` }, label), f];
  };

  function designWahl() {
    const knoepfe = optionen.designs.map((d) => el("button", {
      type: "button", class: "design", "aria-pressed": String(e.design === d.id), title: d.titel,
      onclick: () => {
        setze("design", d.id);
        knoepfe.forEach((k, i) => k.setAttribute("aria-pressed", String(optionen.designs[i].id === d.id)));
        logoBereich.aktualisieren();
      },
    }, el("span", { class: "muster", style: { background: d.hintergrund, color: d.schrift } }, "Ahoi", el("i", { style: { background: d.linie } })), el("small", {}, d.titel)));
    return [el("h3", {}, "Design"), el("div", { class: "designs" }, knoepfe)];
  }

  let logoBereich;
  const logoBereichBauen = () => {
    const aktuell = el("div", { class: "logo-aktuell" });
    const ergebnisse = el("div", { class: "logos" });
    const suche = el("input", { type: "search", id: "logo-suche", placeholder: "Logo suchen: Bayern, Leipzig, JuPi …", oninput: () => zeigen() });
    const schrift = () => optionen.designs.find((d) => d.id === e.design)?.schrift ?? "#000000";
    const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    function aktualisieren() {
      const logo = optionen.logos.find((l) => l.id === e.logo);
      ersetzen(aktuell, logo ? el("img", { src: logoUrl(logo.id, "#000000"), alt: "" }) : "", el("span", {}, logo ? `${logo.titel} (${logo.gruppe})` : "ohne Logo"));
      zeigen();
    }
    function zeigen() {
      const s = norm(suche.value.trim());
      const treffer = s ? optionen.logos.filter((l) => norm(`${l.titel} ${l.gruppe} ${l.id}`).includes(s)).slice(0, 24) : [];
      ersetzen(ergebnisse, ...treffer.map((l) => el("button", {
        type: "button", class: "logo-wahl", "aria-pressed": String(l.id === e.logo),
        onclick: () => {
          setze("logo", l.id);
          suche.value = "";
          aktualisieren();
        },
      }, el("img", { src: logoUrl(l.id, "#000000"), alt: "", loading: "lazy" }), `${l.titel} · ${l.gruppe}`)));
    }
    aktualisieren();
    const block = [
      el("h3", {}, "Logo"),
      aktuell,
      el("label", { for: "logo-suche" }, "Anderes Logo aus ppicng"), suche, ergebnisse,
      el("div", { class: "reihe" },
        el("button", { type: "button", class: "zweit klein", onclick: () => { setze("logo", "kein"); aktualisieren(); } }, "Ohne Logo")),
      ...(istVideo || e.bildStil === "logo" ? [
        ...auswahl("logoStil", [["auto", "Ohne Fläche, Farbe passend zum Bild"], ["glas", "Dunkles Glas, helles Logo"], ["plakette", "Auf Fläche im Design (Plakette)"], ["frei", "Ohne Fläche, immer hell mit Schatten"]], "Logo-Stil"),
        ...auswahl("logoPosition", [["oben-links", "oben links"], ["oben-rechts", "oben rechts"], ["unten-links", "unten links"], ["unten-rechts", "unten rechts"]], "Position"),
      ] : []),
    ];
    return { block, aktualisieren, schrift };
  };

  /** Titelkarte bzw. Abspann: aus, Text oder eigenes Bild. */
  function karteBereich(art) {
    const titel = art === "titelkarte" ? "Titelkarte (vor dem Video)" : "Abspann (nach dem Video)";
    const k = () => (art === "titelkarte" ? e.titelkarte : e.abspannAn ? (e.abspann ?? { art: "text", claim: e.abspannText, text: "" }) : null);
    const inhalt = el("div");
    const bildVorschau = el("img", { class: "kartenbild", alt: `Vorschau ${titel}`, hidden: true });
    const setzeKarte = (wert) => {
      if (art === "titelkarte") e.titelkarte = wert;
      else Object.assign(e, { abspannAn: Boolean(wert), abspann: wert });
      geaendert();
      kartenVorschau();
    };
    const kartenVorschau = verzoegert(async () => {
      if (!k()) return (bildVorschau.hidden = true);
      try {
        const blob = await (await anfrage(`auftrag/${id}/karte`, { methode: "POST", json: { e, art }, roh: true })).blob();
        bildVorschau.src = URL.createObjectURL(blob);
        bildVorschau.hidden = false;
      } catch {}
    }, 500);
    const fehler = el("div");
    function zeichnen() {
      const jetzt = k();
      const modus = !jetzt ? "aus" : jetzt.art === "bild" ? "bild" : "text";
      const s = el("select", { id: `k-${art}`, onchange: () => {
        if (s.value === "aus") setzeKarte(null);
        else if (s.value === "text") setzeKarte({ art: "text", claim: art === "abspann" ? e.abspannText : "", text: "" });
        else datei.click();
        zeichnen();
      } }, [["aus", "aus"], ["text", "Text im Design"], ["bild", "Eigenes Bild (z. B. aus ppicng)"]].map(([w, t]) => el("option", { value: w, selected: modus === w }, t)));
      const datei = el("input", { type: "file", accept: "image/*", class: "unsichtbar", onchange: async () => {
        if (!datei.files[0]) return zeichnen();
        try {
          await sichern();
          a = await hochladen(`auftrag/${id}/bild?zweck=${art}`, datei.files[0]);
          e = { ...e, titelkarte: a.e.titelkarte, abspann: a.e.abspann, abspannAn: a.e.abspannAn };
          geaendert();
          kartenVorschau();
        } catch (err) {
          meldung(fehler, err.message);
        }
        zeichnen();
      } });
      const felder = [];
      if (modus === "text") {
        const claim = el("input", { type: "text", maxlength: 300, id: `k-${art}-claim`, oninput: () => setzeKarte({ ...k(), art: "text", claim: claim.value }) });
        claim.value = jetzt.claim ?? "";
        const text = el("textarea", { maxlength: 800, id: `k-${art}-text`, oninput: () => setzeKarte({ ...k(), art: "text", text: text.value }) });
        text.value = jetzt.text ?? "";
        felder.push(el("label", { for: claim.id }, "Claim"), claim, el("label", { for: text.id }, "Erklärtext (optional)"), text);
      }
      ersetzen(inhalt, el("label", { for: s.id }, titel), s, datei, ...felder, bildVorschau, fehler);
    }
    zeichnen();
    kartenVorschau();
    return inhalt;
  }

  function untertitelBereich() {
    const srt = el("textarea", { class: "srt", id: "srt", spellcheck: "false" });
    srt.value = a.srt;
    const srtFehler = el("div");
    const lagen = Object.entries(optionen.lagen).map(([w, t]) => [w, w === "auto" ? "automatisch (Gesicht bleibt frei)" : t]);
    const infos = [];
    if (!optionen.funktionen.whisper) infos.push("Spracherkennung ist nicht eingerichtet – Untertitel oben im Schnitt einfügen oder eine SRT hier einsetzen.");
    else infos.push("Text korrigieren, neue Untertitel einfügen und Zeiten anpassen: oben im Schnitt unter „Untertitel bearbeiten“.");
    if (a.gesichter !== null && optionen.funktionen.gesicht) infos.push(a.gesichter ? `🙂 Gesicht in ${a.gesichter} Probebildern gefunden.` : "🙂 Kein Gesicht gefunden – Untertitel bleiben unten.");
    for (const h of a.gesichtHinweise) infos.push(`💡 ${h}`);
    return el("details", { open: e.untertitel },
      el("summary", {}, "Untertitel"),
      haken("untertitel", "Untertitel einblenden"),
      ...auswahl("untertitelLage", lagen, "Lage"),
      ...auswahl("untertitelStil", [["box", "Fläche im Design (wie ppicng)"], ["rand", "Weiß mit Kontur"]], "Stil"),
      infos.map((t) => el("p", { class: "leise" }, t)),
      el("details", {},
        el("summary", { class: "klein" }, "SRT-Datei: herunterladen oder einsetzen"),
        a.srt ? el("p", {}, el("a", { href: `/api/auftrag/${id}/srt` }, "SRT des Schnitts herunterladen")) : null,
        el("label", { for: "srt" }, "SRT einsetzen (Zeiten im fertigen Schnitt; ersetzt die sichtbaren Untertitel)"),
        srt,
        el("p", {}, el("button", { type: "button", class: "zweit klein", onclick: async () => {
          try {
            await anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { srt: srt.value } });
            neuLaden();
          } catch (err) {
            meldung(srtFehler, err.message);
          }
        } }, "Übernehmen")),
        srtFehler));
  }

  /** Alles Ungespeicherte (Einstellungen, Schnitt, Untertitel) jetzt speichern – vor Uploads und Neuladen. */
  async function sichern() {
    await Promise.all([speichern.jetzt(), platz?.sichern()]);
  }

  async function neuLaden(meldung) {
    await sichern();
    a = await anfrage(`auftrag/${id}`);
    if (a.status === "arbeitet") beobachten();
    else aufbauen();
    if (meldung) platz?.sagen(meldung);
  }

  /** 9:16-Fassung für Instagram/TikTok und Story – nur sinnvoll, wenn das Video nicht schon 9:16 ist. */
  function fassungBereich() {
    const schonHochkant = () => {
      if (!istVideo) return e.sharepicFormat === "9:16";
      if (e.format === "9:16") return true;
      return e.format === "original" && a.quelle && Math.abs(a.quelle.hoehe / a.quelle.breite - 16 / 9) < 0.03;
    };
    const netze = optionen.hochkantNetze.some((n) => n.startsWith("tiktok")) ? "Instagram/TikTok" : "Instagram";
    const hochkant = istVideo
      ? el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: Boolean(e.hochkant), onchange: (ev) => setze("hochkant", ev.target.checked) }),
        `📲 Zusätzlich eine 9:16-Fassung für ${netze} – die anderen Netzwerke bekommen dieses Format`)
      : null;
    const story = optionen.funktionen.postiz
      ? el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: Boolean(e.story), onchange: (ev) => setze("story", ev.target.checked) }), "📱 Beim Posten auch als Story auf Instagram/Facebook")
      : null;
    const hinweis = el("p", { class: "leise" });
    const aktualisieren = () => {
      const schon = schonHochkant();
      if (hochkant) hochkant.hidden = schon;
      hinweis.textContent = schon ? "" : istVideo
        ? "Das Querformat landet dann mittig auf einer unscharfen Kopie, Logo darüber, Bauchbinde im Bild, Untertitel darunter."
        : e.story ? "Für die Story baue ich dasselbe Sharepic zusätzlich in 9:16." : "";
    };
    beiAenderung.push(aktualisieren);
    aktualisieren();
    return [hochkant, story, hinweis].filter(Boolean);
  }

  function tonBereich() {
    const t = () => e.ton ?? { angleichen: true, rauschen: false, musik: null };
    const setzeTon = (felder) => {
      e.ton = { ...t(), ...felder };
      geaendert();
    };
    const fehler = el("div");
    const datei = el("input", { type: "file", accept: "audio/*", class: "unsichtbar", id: "musik-datei", onchange: async () => {
      if (!datei.files[0]) return;
      meldung(fehler, "Lade hoch …", "leise");
      try {
        await sichern();
        a = await hochladen(`auftrag/${id}/musik?name=${encodeURIComponent(datei.files[0].name)}`, datei.files[0]);
        e.ton = a.e.ton;
        geaendert();
        aufbauen();
      } catch (err) {
        meldung(fehler, err.message);
      }
    } });
    const m = t().musik;
    const musikTeile = m
      ? [
        el("p", {}, "🎵 ", el("strong", {}, m.name), ` · ${zeitGenau(m.dauer)} – läuft in Schleife unter dem Video`),
        el("label", { for: "musik-laut" }, "Lautstärke der Musik"),
        el("input", { type: "range", id: "musik-laut", min: "0", max: "100", step: "5", value: String(Math.round((m.lautstaerke ?? 0.25) * 100)), onchange: (ev) => setzeTon({ musik: { ...m, lautstaerke: Number(ev.target.value) / 100 } }) }),
        el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: m.ducking !== false, onchange: (ev) => setzeTon({ musik: { ...m, ducking: ev.target.checked } }) }), "Leiser, wenn gesprochen wird (im fertigen Video)"),
        el("label", { for: "musik-ab" }, "Musik beginnt bei (Sekunde im Stück)"),
        el("input", { type: "number", id: "musik-ab", min: "0", step: "0.5", max: String(Math.max(0, m.dauer - 1)), value: String(m.ab ?? 0), onchange: (ev) => setzeTon({ musik: { ...m, ab: Number(ev.target.value) || 0 } }) }),
        el("p", { class: "reihe" },
          el("label", { for: "musik-datei", class: "knopf zweit klein", tabindex: "0" }, "Andere Musik"),
          el("button", { type: "button", class: "zweit klein", onclick: () => { setzeTon({ musik: null }); aufbauen(); } }, "Musik entfernen")),
      ]
      : [el("p", {}, el("label", { for: "musik-datei", class: "knopf zweit klein", tabindex: "0" }, "🎵 Musik hinzufügen"))];
    return el("details", { open: Boolean(m) || t().rauschen },
      el("summary", {}, "Ton"),
      el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: t().angleichen !== false, onchange: (ev) => setzeTon({ angleichen: ev.target.checked }) }), "Lautstärke angleichen (wie Instagram & Co. es erwarten)"),
      el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: Boolean(t().rauschen), onchange: (ev) => setzeTon({ rauschen: ev.target.checked }) }), "Rauschminderung (Wind, Rauschen)"),
      el("p", { class: "leise" }, "Lautstärke einzelner Stellen und Stummschalten: oben im Schnitt den Teil auswählen."),
      ...musikTeile, datei, fehler,
      el("p", { class: "leise" }, "Nur Musik verwenden, die ihr nutzen dürft (z. B. GEMA-frei oder eigene)."));
  }

  function bauchbindeBereich() {
    const name = el("input", { type: "text", id: "bb-name", maxlength: 60, oninput: () => { e.bauchbinde = { ...(e.bauchbinde ?? {}), name: name.value }; geaendert(); } });
    const funktion = el("input", { type: "text", id: "bb-funktion", maxlength: 80, oninput: () => { e.bauchbinde = { ...(e.bauchbinde ?? {}), funktion: funktion.value }; geaendert(); } });
    name.value = e.bauchbinde?.name ?? "";
    funktion.value = e.bauchbinde?.funktion ?? "";
    return el("details", { open: e.bauchbindeAn },
      el("summary", {}, "Bauchbinde"),
      haken("bauchbindeAn", "Name und Funktion am Anfang einblenden"),
      el("label", { for: "bb-name" }, "Name"), name,
      el("label", { for: "bb-funktion" }, "Funktion"), funktion);
  }

  function fotoBereich() {
    const fehler = el("div");
    const datei = el("input", { type: "file", accept: "image/*", class: "unsichtbar", id: "foto", onchange: async () => {
      if (!datei.files[0]) return;
      try {
        await sichern();
        a = await hochladen(`auftrag/${id}/bild?zweck=foto`, datei.files[0]);
        e = { ...e, bild: true, bildStil: a.e.bildStil };
        geaendert();
        aufbauen();
      } catch (err) {
        meldung(fehler, err.message);
      }
    } });
    return [
      el("h3", {}, "Foto"),
      e.bild ? auswahl("bildStil", Object.entries(optionen.bildstile), "Foto-Stil") : el("p", { class: "leise" }, "Optional: ein Foto neben die Textfläche, als Hintergrund – oder nur das Logo aufs Foto."),
      el("label", { for: "foto", class: "knopf zweit", tabindex: "0" }, e.bild ? "Anderes Foto" : "Foto hinzufügen"), datei, fehler,
    ].flat();
  }

  // --- Text und Posten ---
  const textBereich = (() => {
    const caption = el("textarea", { id: "caption", rows: 6, oninput: () => captionSpeichern() });
    const hinweis = el("p", { class: "leise" });
    const captionSpeichern = verzoegert(() => anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { caption: caption.value } }).catch(() => {}), 800);
    const kiWunsch = el("input", { type: "text", id: "ki-wunsch", placeholder: "Wunsch, z. B. kürzer, lockerer …" });
    const kiFehler = el("div");
    function setzen() {
      caption.value = a.caption;
      hinweis.textContent = a.captionHinweis;
    }
    setzen();
    const block = el("div", {},
      el("label", { for: "caption" }, "Beitragstext"), caption, hinweis,
      optionen.funktionen.ki ? el("div", { class: "reihe" }, kiWunsch, el("button", { type: "button", class: "lila klein", onclick: async (ev) => {
        ev.target.disabled = true;
        meldung(kiFehler, "");
        try {
          captionSpeichern.sofort();
          a = await anfrage(`auftrag/${id}/ki`, { methode: "POST", json: { hinweis: kiWunsch.value } });
          setzen();
        } catch (err) {
          meldung(kiFehler, err.message);
        }
        ev.target.disabled = false;
      } }, "🔄 Neu formulieren")) : null,
      kiFehler);
    return { block, wert: () => caption.value, setzen };
  })();

  async function postenBereich(ziel) {
    let daten;
    try {
      daten = await anfrage(`auftrag/${id}/kanaele`);
    } catch (err) {
      return ersetzen(ziel, el("p", { class: "fehler" }, err.message));
    }
    const gewaehlt = new Set(daten.gewaehlt);
    const nachKunde = new Map();
    for (const c of daten.kanaele) {
      const k = c.kunde ?? "Ohne Kunde";
      if (!nachKunde.has(k)) nachKunde.set(k, []);
      nachKunde.get(k).push(c);
    }
    const zaehler = [];
    const kanaele = el("div", { class: "kanaele" }, [...nachKunde].map(([kunde, liste]) => [
      el("strong", {}, kunde),
      liste.map((c) => {
        const anzeige = el("small");
        zaehler.push(() => {
          const n = textBereich.wert().length;
          anzeige.textContent = c.max ? ` ${n}/${c.max}` : "";
          anzeige.className = c.max && n > c.max ? "fehler" : "";
        });
        return el("label", { class: "zeile" }, el("input", { type: "checkbox", checked: gewaehlt.has(c.id), onchange: (ev) => (ev.target.checked ? gewaehlt.add(c.id) : gewaehlt.delete(c.id)) }), `${c.name} (${c.identifier})`, anzeige);
      }),
    ]));
    const aktualisieren = () => zaehler.forEach((f) => f());
    document.getElementById("caption").addEventListener("input", aktualisieren);
    aktualisieren();
    const zeit = el("input", { type: "datetime-local", id: "zeit" });
    const fehler = el("div");
    const posten = async (planen, kuerzen = false) => {
      meldung(fehler, "");
      if (planen && !zeit.value) return meldung(fehler, "Bitte einen Zeitpunkt wählen.");
      const ziele = daten.kanaele.filter((c) => gewaehlt.has(c.id)).map((c) => c.name).join(", ");
      if (!kuerzen && !confirm(`Wirklich ${planen ? `am ${new Date(zeit.value).toLocaleString("de-DE")}` : "jetzt"} auf ${ziele || "–"} posten?`)) return;
      try {
        a = await anfrage(`auftrag/${id}/posten`, { methode: "POST", json: { kanaele: [...gewaehlt], caption: textBereich.wert(), zeit: planen ? new Date(zeit.value).toISOString() : null, kuerzen } });
        aufbauen();
      } catch (err) {
        if (err.status === 422) {
          ersetzen(fehler, el("p", { class: "fehler" }, `${err.message} ${err.daten.probleme.map((p) => `${p.name}: ${p.n}/${p.max}`).join(", ")}`),
            el("button", { type: "button", class: "klein", onclick: () => posten(planen, true) }, "✂️ Automatisch kürzen und posten"));
        } else {
          meldung(fehler, err.message);
        }
      }
    };
    ersetzen(ziel, 
      el("h3", {}, "Posten über Postiz"),
      kanaele,
      el("p", { class: "reihe" }, el("button", { type: "button", onclick: () => posten(false) }, "✅ Jetzt posten")),
      el("label", { for: "zeit" }, "oder planen für"),
      el("div", { class: "reihe" }, zeit, el("button", { type: "button", class: "zweit", onclick: () => posten(true) }, "🕐 Planen")),
      fehler);
  }

  // --- Seitenleiste: Stand, Bauen, Herunterladen ---
  function zeigeAktionen() {
    const fertig = ["gepostet", "geplant"].includes(a.status);
    const teile = [];
    if (a.fehler) teile.push(el("p", { class: "fehler", role: "alert" }, a.fehler));
    for (const w of a.warnungen) teile.push(el("p", { class: "leise" }, `⚠️ ${w}`));
    if (fertig) {
      teile.push(el("p", { class: "gut" }, a.status === "geplant" ? `🕐 Geplant für ${new Date(a.plan.zeit).toLocaleString("de-DE")}.` : "✅ Gepostet."));
    } else if (a.status !== "arbeitet") {
      const aktuell = a.ergebnis && !a.geaendert;
      teile.push(el("p", { class: "reihe" }, el("button", { type: "button", class: aktuell ? "zweit" : undefined, onclick: bauen },
        aktuell ? "🔁 Neu bauen" : istVideo ? "🎬 Video bauen" : "💾 Fertig machen")));
    }
    if (a.ergebnis && !a.geaendert) {
      teile.push(el("p", { class: "reihe" },
        el("a", { class: "knopf zweit", href: `/api/auftrag/${id}/datei`, download: "" }, "📥 Herunterladen"),
        a.fassung916 ? el("a", { class: "knopf zweit", href: `/api/auftrag/${id}/datei?fassung=916`, download: "" }, istVideo ? "📥 9:16-Fassung" : "📥 Story (9:16)") : null));
    } else if (a.ergebnis) {
      teile.push(el("p", { class: "leise" }, "Geändert – zum Herunterladen und Posten neu bauen."));
    }
    ersetzen(aktionen, ...teile);
    if (optionen.posten && a.ergebnis && !a.geaendert && !fertig && a.status !== "arbeitet") {
      const ziel = el("div");
      aktionen.append(ziel);
      postenBereich(ziel);
    }
  }

  async function bauen() {
    a.fehler = "";
    try {
      a = await anfrage(`auftrag/${id}/bauen`, { methode: "POST", json: { e, caption: textBereich.wert(), ...(platz ? platz.stand() : {}) } });
    } catch (err) {
      a.fehler = err.message;
    }
    textBereich.setzen();
    if (istVideo) beobachten();
    else {
      zeigeErgebnis();
      zeigeAktionen();
    }
  }

  let zeigeFassung = "haupt";
  function zeigeErgebnis() {
    if (!a.ergebnis || a.geaendert) {
      ersetzen(fassungWahl);
      return vorschauLaden.sofort();
    }
    if (!a.fassung916) zeigeFassung = "haupt";
    const hoch = zeigeFassung === "916";
    const v = hoch ? a.fassung916.version : a.ergebnis.version;
    const umschalter = a.fassung916
      ? el("div", { class: "reihe fassungen", role: "group", "aria-label": "Fassung" },
        ...[["haupt", istVideo ? "Hauptfassung" : "Beitrag"], ["916", istVideo ? "9:16 für Instagram/TikTok" : "Story 9:16"]].map(([wert, text]) =>
          el("button", { type: "button", class: `klein ${zeigeFassung === wert ? "" : "zweit"}`, "aria-pressed": String(zeigeFassung === wert), onclick: () => { zeigeFassung = wert; zeigeErgebnis(); } }, text)))
      : null;
    if (istVideo) {
      const { breite, hoehe } = hoch ? { breite: 1080, hoehe: 1920 } : a.ergebnis.masse;
      ersetzen(vorschau, el("video", { src: `/api/auftrag/${id}/vorschaudatei?v=${v}${hoch ? "&fassung=916" : ""}`, controls: true, playsinline: true, preload: "metadata", style: { aspectRatio: `${breite} / ${hoehe}`, width: breite > hoehe ? "100%" : "auto", height: breite > hoehe ? "auto" : "70vh" } }));
      const lageText = !a.lageAutomatisch || !a.lage || a.lage === "unten" ? ""
        : a.lage === "unter-bild" ? " · Untertitel unter dem Bild, Logo darüber"
          : ` · Untertitel ${a.lage === "oben" ? "oben" : "in der Mitte"} (unten wäre das Gesicht verdeckt)`;
      vorschauInfo.textContent = `Fertiges Video (Vorschau in kleiner Auflösung) · ${a.ergebnis.masse.breite}×${a.ergebnis.masse.hoehe}${lageText}`;
    } else {
      ersetzen(vorschau, el("img", { src: `/api/auftrag/${id}/vorschaudatei?v=${v}${hoch ? "&fassung=916" : ""}`, alt: "Fertiges Sharepic" }));
      vorschauInfo.textContent = "";
    }
    ersetzen(fassungWahl, umschalter);
  }

  /** Solange der Server arbeitet: Stand abfragen. */
  async function beobachten() {
    while (!abbruch.signal.aborted) {
      if (a.status !== "arbeitet") break;
      ersetzen(status, el("div", { class: "schritt" }, el("span", { class: "drehen", "aria-hidden": "true" }), a.schritt || "Arbeite …"));
      if (!a.ergebnis || a.geaendert) oben.querySelector(".schnittplatz")?.classList.add("gesperrt");
      ersetzen(aktionen, );
      await new Promise((r) => setTimeout(r, 1500));
      try {
        a = await anfrage(`auftrag/${id}`);
      } catch {
        return;
      }
    }
    ersetzen(status, );
    // Nach der Analyse stehen Untertitel, Gesichtshinweise und Text fest – Formular neu aufbauen
    aufbauen();
  }

  function aufbauen() {
    e = structuredClone(a.e);
    beiAenderung.length = 0;
    logoBereich = logoBereichBauen();
    const kopf = istVideo
      ? [el("h1", {}, "🎬 Gestaltung"), a.quelle ? el("p", { class: "leise" }, `${a.clips.length === 1 ? "1 Clip" : `${a.clips.length} Clips`}, erster ${a.quelle.breite}×${a.quelle.hoehe}${a.quelle.hatTon ? "" : ", ohne Ton"}`) : null]
      : [el("h1", {}, "🖼️ Sharepic")];
    const teile = [...kopf];
    if (!istVideo) {
      teile.push(...textfeld("claim", "Claim", { mehrzeilig: true, max: 300 }), ...textfeld("text", "Erklärtext (optional)", { mehrzeilig: true, max: 800 }));
      teile.push(...auswahl("sharepicFormat", optionen.sharepicFormate.map((f) => [f, optionen.formate.find((x) => x.id === f).titel]), "Format"));
      teile.push(...fassungBereich());
      teile.push(...designWahl(), ...logoBereich.block, ...fotoBereich());
    } else {
      teile.push(...auswahl("format", optionen.formate.map((f) => [f.id, f.titel]), "Format"));
      teile.push(...auswahl("anpassen", [["rand", "mit unscharfem Rand auffüllen"], ["zuschneiden", "zuschneiden"]], "Passt nicht genau?"));
      teile.push(...fassungBereich());
      teile.push(...designWahl(), ...logoBereich.block);
      teile.push(untertitelBereich(), tonBereich(), bauchbindeBereich(),
        el("details", { open: Boolean(e.titelkarte || e.abspannAn) }, el("summary", {}, "Titelkarte und Abspann"), karteBereich("titelkarte"), karteBereich("abspann")));
    }
    teile.push(el("h3", {}, "Text für den Beitrag"), textBereich.block);
    teile.push(el("p", {}, el("button", { type: "button", class: "zweit klein", onclick: async () => {
      if (!confirm("Diesen Beitrag verwerfen?")) return;
      await anfrage(`auftrag/${id}/verwerfen`, { methode: "POST" }).catch(() => {});
      location.hash = "#/meine";
    } }, "🗑️ Verwerfen")));
    ersetzen(formular, ...teile);
    platz = istVideo && a.clips.length
      ? schnittplatz({
        id, a,
        geaendertMelden: () => {
          a.geaendert = true;
          zeigeAktionen();
        },
        standbildHier: (t) => {
          standbildZeit = t;
          vorschauLaden.sofort();
          seitenleiste.scrollIntoView({ behavior: "smooth", block: "nearest" });
        },
        neuLaden,
        ton: () => e.ton,
        untertitelAn: () => {
          if (e.untertitel) return;
          setze("untertitel", true);
          const haken = formular.querySelector("details input[type=checkbox]");
          if (haken) haken.checked = true;
        },
      })
      : null;
    ersetzen(oben, platz?.element ?? "");
    textBereich.setzen();
    logoBereich.aktualisieren();
    zeigeErgebnis();
    zeigeAktionen();
  }

  if (a.status === "arbeitet") {
    ersetzen(formular, el("h1", {}, istVideo ? "🎬 Video" : "🖼️ Sharepic"), el("p", { class: "leise" }, "Das Video wird vorbereitet – Arbeitskopie zum Schneiden, Spracherkennung und Gesichtssuche können auf dem Pi ein paar Minuten dauern."));
    beobachten();
  } else {
    aufbauen();
  }
}

// ---------- Navigation ----------

async function route() {
  abbruch?.abort();
  abbruch = new AbortController();
  try {
    const m = location.hash.match(/^#\/a\/([0-9a-f]+)$/);
    const ueber = location.hash.match(/^#\/uebernehmen\/([0-9a-f]+)\/([0-9a-f]+)$/);
    if (ueber) {
      const a = await anfrage("uebernehmen", { methode: "POST", json: { id: ueber[1], schluessel: ueber[2] } });
      history.replaceState(null, "", `#/a/${a.id}`);
      await editor(a.id);
    } else if (m) await editor(m[1]);
    else if (location.hash === "#/meine") await meineSeite();
    else startseite();
  } catch (e) {
    if (e.name !== "AbortError" && e.message !== "Bitte anmelden.") ersetzen(app, el("p", { class: "fehler" }, e.message), el("p", {}, el("a", { href: "#/" }, "Zur Startseite")));
  }
}

async function start() {
  let ich;
  try {
    ich = await fetch("/api/ich").then((r) => r.json());
  } catch {
    ersetzen(app, el("p", { class: "fehler" }, "Der Server ist nicht erreichbar."));
    return;
  }
  modus = ich.modus;
  if (!ich.nutzer) {
    optionen = null;
    if (modus === "anmeldung") return zeigeAnmeldung(ich);
    ersetzen(app, el("p", { class: "fehler" }, "Gerade kommen zu viele neue Besuche von deiner Adresse – bitte später nochmal."));
    return;
  }
  try {
    optionen = await anfrage("optionen");
  } catch {
    return;
  }
  document.getElementById("nav").hidden = false;
  document.getElementById("abmelden").hidden = modus !== "anmeldung";
  route();
}

window.addEventListener("hashchange", () => optionen && route());
start();
