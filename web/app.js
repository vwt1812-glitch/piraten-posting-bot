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
  for (const kind of kinder.flat()) if (kind !== null && kind !== undefined && kind !== false) e.append(kind instanceof Node ? kind : String(kind));
  return e;
}

async function anfrage(pfad, { methode = "GET", json, body, kopf = {}, roh = false } = {}) {
  const res = await fetch(`/api/${pfad}`, {
    method: methode,
    headers: { ...(methode !== "GET" ? { "X-PPB": "1" } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...kopf },
    body: json !== undefined ? JSON.stringify(json) : body,
    signal: abbruch?.signal,
  });
  if (res.status === 401 && pfad !== "anmelden") {
    zeigeAnmeldung();
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
  let t;
  const f = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  f.sofort = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return f;
};

function meldung(ziel, text, art = "fehler") {
  ziel.replaceChildren(text ? el("p", { class: art, role: art === "fehler" ? "alert" : "status" }, text) : "");
}

const logoUrl = (id, schrift = "000000") => `/api/logo/${id}?schrift=${schrift.replace("#", "")}`;
const dauerText = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// ---------- Anmeldung ----------

async function zeigeAnmeldung() {
  document.getElementById("nav").hidden = true;
  const { anmeldung } = await fetch("/api/ich").then((r) => r.json());
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
  app.replaceChildren(form);
  (anmeldung.matrix ? nutzer : passwort).focus();
}

document.getElementById("abmelden").addEventListener("click", async () => {
  await anfrage("abmelden", { methode: "POST" }).catch(() => {});
  zeigeAnmeldung();
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
  app.replaceChildren(
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
    optionen.ppicngUrl ? el("p", { class: "leise" }, "Mehr Designs für Bilder gibt es in ", el("a", { href: optionen.ppicngUrl, rel: "noopener" }, "ppicng"), ".") : null,
  );
}

async function meineSeite() {
  const liste = await anfrage("auftraege");
  const statusText = { entwurf: "Entwurf", bereit: "fertig", gepostet: "gepostet", geplant: "geplant", arbeitet: "in Arbeit", fehler: "Fehler" };
  app.replaceChildren(
    el("h1", {}, "Meine Beiträge"),
    liste.length
      ? el("ul", { class: "liste" }, liste.map((a) => el("li", {}, el("a", { href: `#/a/${a.id}` },
        el("span", {}, `${a.art === "video" ? "🎬" : "🖼️"} ${a.titel}`),
        el("span", { class: "leise" }, `${statusText[a.status] ?? a.status} · ${new Date(a.erstellt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}`)))))
      : el("p", { class: "leise" }, "Noch nichts – leg los unter „Neu“."),
    el("p", { class: "leise" }, "Beiträge werden nach 14 Tagen gelöscht."),
  );
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
  const seitenleiste = el("div", { class: "vorschau-spalte" }, el("div", { class: "karte" }, vorschau, vorschauInfo, status, aktionen));
  app.replaceChildren(el("div", { class: "editor" }, formular, seitenleiste));

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
    vorschau.replaceChildren(el("img", { src: vorschauUrl, alt: "Vorschau" }), ...(hinweis ? [el("span", { class: "hinweis" }, hinweis)] : []));
  };
  const vorschauLaden = verzoegert(async () => {
    if (istVideo && (!a.quelle || a.status === "arbeitet")) return;
    const nr = ++vorschauNr;
    vorschau.classList.add("arbeitet");
    try {
      const res = await anfrage(`auftrag/${id}/vorschau`, { methode: "POST", json: { e }, roh: true });
      const blob = await res.blob();
      if (nr !== vorschauNr) return;
      const lage = res.headers.get("X-Lage");
      bildZeigen(blob, istVideo ? `Standbild${e.untertitel && lage ? ` · Untertitel ${{ unten: "unten", mitte: "Mitte", oben: "oben" }[lage]}${e.untertitelLage === "auto" ? " (automatisch)" : ""}` : ""}` : null);
    } catch (err) {
      if (nr === vorschauNr && err.name !== "AbortError") vorschau.replaceChildren(el("p", { class: "fehler" }, err.message));
    } finally {
      if (nr === vorschauNr) vorschau.classList.remove("arbeitet");
    }
  }, istVideo ? 1200 : 350);

  const geaendert = () => {
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
      aktuell.replaceChildren(logo ? el("img", { src: logoUrl(logo.id, "#000000"), alt: "" }) : "", el("span", {}, logo ? `${logo.titel} (${logo.gruppe})` : "ohne Logo"));
      zeigen();
    }
    function zeigen() {
      const s = norm(suche.value.trim());
      const treffer = s ? optionen.logos.filter((l) => norm(`${l.titel} ${l.gruppe} ${l.id}`).includes(s)).slice(0, 24) : [];
      ergebnisse.replaceChildren(...treffer.map((l) => el("button", {
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
        ...auswahl("logoStil", [["plakette", "Auf Fläche im Design (Plakette)"], ["frei", "Frei, helles Logo mit Schatten"]], "Logo-Stil"),
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
      inhalt.replaceChildren(el("label", { for: s.id }, titel), s, datei, ...felder, bildVorschau, fehler);
    }
    zeichnen();
    kartenVorschau();
    return inhalt;
  }

  function untertitelBereich() {
    const srt = el("textarea", { class: "srt", id: "srt", spellcheck: "true" });
    srt.value = a.srt;
    const srtSpeichern = verzoegert(async () => {
      try {
        a = await anfrage(`auftrag/${id}/speichern`, { methode: "POST", json: { srt: srt.value } });
        a.geaendert = true;
        vorschauLaden();
        zeigeAktionen();
      } catch {}
    }, 1000);
    srt.addEventListener("input", srtSpeichern);
    const lagen = Object.entries(optionen.lagen).map(([w, t]) => [w, w === "auto" ? "automatisch (Gesicht bleibt frei)" : t]);
    const infos = [];
    if (!optionen.funktionen.whisper) infos.push("Spracherkennung ist nicht eingerichtet – Untertitel als SRT hier hineinkopieren.");
    if (a.gesichter !== null && optionen.funktionen.gesicht) infos.push(a.gesichter ? `🙂 Gesicht in ${a.gesichter} Probebildern gefunden.` : "🙂 Kein Gesicht gefunden – Untertitel bleiben unten.");
    for (const h of a.gesichtHinweise) infos.push(`💡 ${h}`);
    return el("details", { open: e.untertitel },
      el("summary", {}, "Untertitel"),
      haken("untertitel", "Untertitel einblenden"),
      ...auswahl("untertitelLage", lagen, "Lage"),
      ...auswahl("untertitelStil", [["box", "Fläche im Design (wie ppicng)"], ["rand", "Weiß mit Kontur"]], "Stil"),
      el("label", { for: "srt" }, "Text und Zeiten (SRT) – hier direkt korrigieren"),
      srt,
      infos.map((t) => el("p", { class: "leise" }, t)),
      a.srt ? el("p", {}, el("a", { href: `/api/auftrag/${id}/srt` }, "SRT herunterladen")) : null);
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
      return ziel.replaceChildren(el("p", { class: "fehler" }, err.message));
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
          fehler.replaceChildren(el("p", { class: "fehler" }, `${err.message} ${err.daten.probleme.map((p) => `${p.name}: ${p.n}/${p.max}`).join(", ")}`),
            el("button", { type: "button", class: "klein", onclick: () => posten(planen, true) }, "✂️ Automatisch kürzen und posten"));
        } else {
          meldung(fehler, err.message);
        }
      }
    };
    ziel.replaceChildren(
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
      teile.push(el("p", {}, el("a", { class: "knopf zweit", href: `/api/auftrag/${id}/datei`, download: "" }, "📥 Herunterladen")));
    } else if (a.ergebnis) {
      teile.push(el("p", { class: "leise" }, "Geändert – zum Herunterladen und Posten neu bauen."));
    }
    aktionen.replaceChildren(...teile);
    if (optionen.posten && a.ergebnis && !a.geaendert && !fertig && a.status !== "arbeitet") {
      const ziel = el("div");
      aktionen.append(ziel);
      postenBereich(ziel);
    }
  }

  async function bauen() {
    a.fehler = "";
    try {
      a = await anfrage(`auftrag/${id}/bauen`, { methode: "POST", json: { e, caption: textBereich.wert() } });
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

  function zeigeErgebnis() {
    if (!a.ergebnis || a.geaendert) return vorschauLaden.sofort();
    const v = a.ergebnis.version;
    if (istVideo) {
      const { breite, hoehe } = a.ergebnis.masse;
      vorschau.replaceChildren(el("video", { src: `/api/auftrag/${id}/vorschaudatei?v=${v}`, controls: true, playsinline: true, preload: "metadata", style: { aspectRatio: `${breite} / ${hoehe}`, width: breite > hoehe ? "100%" : "auto", height: breite > hoehe ? "auto" : "70vh" } }));
      const lageText = a.lageAutomatisch && a.lage && a.lage !== "unten" ? ` · Untertitel ${a.lage === "oben" ? "oben" : "in der Mitte"} (unten wäre das Gesicht verdeckt)` : "";
      vorschauInfo.textContent = `Fertiges Video (Vorschau in kleiner Auflösung) · ${a.ergebnis.masse.breite}×${a.ergebnis.masse.hoehe}${lageText}`;
    } else {
      vorschau.replaceChildren(el("img", { src: `/api/auftrag/${id}/vorschaudatei?v=${v}`, alt: "Fertiges Sharepic" }));
      vorschauInfo.textContent = "";
    }
  }

  /** Solange der Server arbeitet: Stand abfragen. */
  async function beobachten() {
    while (!abbruch.signal.aborted) {
      if (a.status !== "arbeitet") break;
      status.replaceChildren(el("div", { class: "schritt" }, el("span", { class: "drehen", "aria-hidden": "true" }), a.schritt || "Arbeite …"));
      aktionen.replaceChildren();
      await new Promise((r) => setTimeout(r, 1500));
      try {
        a = await anfrage(`auftrag/${id}`);
      } catch {
        return;
      }
    }
    status.replaceChildren();
    // Nach der Analyse stehen Untertitel, Gesichtshinweise und Text fest – Formular neu aufbauen
    aufbauen();
  }

  function aufbauen() {
    e = structuredClone(a.e);
    logoBereich = logoBereichBauen();
    const kopf = istVideo
      ? [el("h1", {}, "🎬 Video"), a.quelle ? el("p", { class: "leise" }, `${a.quelle.breite}×${a.quelle.hoehe}, ${dauerText(a.quelle.dauer)} min${a.quelle.hatTon ? "" : ", ohne Ton"}`) : null]
      : [el("h1", {}, "🖼️ Sharepic")];
    const teile = [...kopf];
    if (!istVideo) {
      teile.push(...textfeld("claim", "Claim", { mehrzeilig: true, max: 300 }), ...textfeld("text", "Erklärtext (optional)", { mehrzeilig: true, max: 800 }));
      teile.push(...auswahl("sharepicFormat", optionen.sharepicFormate.map((f) => [f, optionen.formate.find((x) => x.id === f).titel]), "Format"));
      teile.push(...designWahl(), ...logoBereich.block, ...fotoBereich());
    } else {
      teile.push(...auswahl("format", optionen.formate.map((f) => [f.id, f.titel]), "Format"));
      teile.push(...auswahl("anpassen", [["rand", "mit unscharfem Rand auffüllen"], ["zuschneiden", "zuschneiden"]], "Passt nicht genau?"));
      teile.push(...designWahl(), ...logoBereich.block);
      teile.push(untertitelBereich(), bauchbindeBereich(),
        el("details", { open: Boolean(e.titelkarte || e.abspannAn) }, el("summary", {}, "Titelkarte und Abspann"), karteBereich("titelkarte"), karteBereich("abspann")));
    }
    teile.push(el("h3", {}, "Text für den Beitrag"), textBereich.block);
    teile.push(el("p", {}, el("button", { type: "button", class: "zweit klein", onclick: async () => {
      if (!confirm("Diesen Beitrag verwerfen?")) return;
      await anfrage(`auftrag/${id}/verwerfen`, { methode: "POST" }).catch(() => {});
      location.hash = "#/meine";
    } }, "🗑️ Verwerfen")));
    formular.replaceChildren(...teile);
    textBereich.setzen();
    logoBereich.aktualisieren();
    zeigeErgebnis();
    zeigeAktionen();
  }

  if (a.status === "arbeitet") {
    formular.replaceChildren(el("h1", {}, istVideo ? "🎬 Video" : "🖼️ Sharepic"), el("p", { class: "leise" }, "Das Video wird vorbereitet – Spracherkennung und Gesichtssuche können auf dem Pi ein paar Minuten dauern."));
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
    if (m) await editor(m[1]);
    else if (location.hash === "#/meine") await meineSeite();
    else startseite();
  } catch (e) {
    if (e.name !== "AbortError" && e.message !== "Bitte anmelden.") app.replaceChildren(el("p", { class: "fehler" }, e.message), el("p", {}, el("a", { href: "#/" }, "Zur Startseite")));
  }
}

async function start() {
  try {
    optionen = await anfrage("optionen");
  } catch {
    return;
  }
  document.getElementById("nav").hidden = false;
  route();
}

window.addEventListener("hashchange", () => optionen && route());
start();
