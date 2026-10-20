// Die Werkstatt: alles, was Bot (Telegram/Matrix) und Web-Version gemeinsam brauchen – Aufträge anlegen,
// Spracherkennung, Gesichtssuche, Beitragstext, Bauen von Video und Sharepic, Postiz. Eine Warteschlange für
// alles, was ffmpeg oder Whisper braucht: Es läuft immer nur eins davon gleichzeitig (der Pi dankt).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chatStandard } from "./config.mjs";
import { Auftraege } from "./auftraege.mjs";
import { logoNachId, farbschema } from "./ppicng.mjs";
import { sharepic, fotoMitLogo, eigenesBild } from "./grafik.mjs";
import { tonUntersuchen, untersuche, tonFuerWhisper, rendern, renderArgs, vorschau, zielMasse, FORMATE, fotoFuerKi, ausfuehren, arbeitskopie } from "./video.mjs";
import { transkribiere } from "./whisper.mjs";
import { parseSrt, formatSrt, zuAss, volltext, wendeKorrekturenAn } from "./untertitel.mjs";
import { ganzerClip, schnittCues, cuesZurueck, schnittDauer, imClip } from "./schnitt.mjs";
import { captionVorschlag } from "./caption.mjs";
import { gesichtSuchen, lageFuer } from "./gesicht.mjs";
import { Postiz, AnfragenZaehler, passendeKanaele, passtZu, findeKunde, kanaeleVonKunde, zeichenLimit, zeichenZahl } from "./postiz.mjs";

export class Werkstatt {
  constructor({ config, ppicng }) {
    this.config = config;
    this.ppicng = ppicng;
    this.auftraege = new Auftraege(config.datenDir);
    this.zaehler = new AnfragenZaehler(path.join(config.datenDir, "postiz-anfragen.json"), config.postiz?.maxAnfragen ?? 0);
    this.postiz = config.postiz ? new Postiz({ ...config.postiz, zaehler: this.zaehler }) : null;
    this.schlange = Promise.resolve();
    this.wartend = 0;
    this.kanalCache = { zeit: 0, liste: [] };
    this.gesichtAktiv = Boolean(config.gesicht?.python && fs.existsSync(config.gesicht.python));
  }

  /** In die Warteschlange; `fn` läuft, wenn alles davor fertig ist. */
  arbeit(fn) {
    this.wartend++;
    const lauf = this.schlange.then(fn).finally(() => this.wartend--);
    this.schlange = lauf.catch(() => {});
    return lauf;
  }

  // ---------- Aufträge ----------

  /** Neuer Auftrag mit den Voreinstellungen des Chats/Raums (bzw. der Web-Nutzerin). */
  neu({ plattform, chat, art, von }) {
    const std = chatStandard(this.config, chat);
    const a = this.auftraege.neu(`${plattform}|${chat}`);
    return this.auftraege.aendern(a.id, {
      plattform, chat, art, von,
      status: "arbeitet",
      e: {
        design: std.design,
        logo: std.logo,
        logoStil: std.logoStil,
        logoPosition: std.logoPosition,
        logoBreite: std.logoBreite,
        format: std.format,
        anpassen: std.anpassen,
        untertitel: std.untertitel && Boolean(this.config.whisper),
        untertitelStil: std.untertitelStil,
        // „auto“: dorthin, wo die Untertitel das Gesicht nicht verdecken (nur mit OpenCV)
        untertitelLage: this.gesichtAktiv ? "auto" : "unten",
        bauchbinde: std.bauchbinde,
        bauchbindeAn: std.bauchbindeAn && Boolean(std.bauchbinde?.name),
        titelkarte: null,
        abspannAn: std.abspannAn,
        abspann: null,
        abspannText: std.abspannText,
        sharepicFormat: std.sharepicFormat,
        // Ton: Lautheit angleichen (für Social Media), Rauschminderung, Hintergrundmusik
        ton: { angleichen: std.tonAngleichen, rauschen: std.tonRauschen, musik: null },
        claim: "",
        text: "",
        bild: null,
        bildStil: "geteilt",
      },
      absender: std.absender,
      hashtags: std.hashtags,
      kundeName: std.postizKunde,
    });
  }

  aendern(a, felder) {
    return this.auftraege.aendern(a.id, felder);
  }

  // ---------- Clips, Schnitt, Untertitel ----------
  // a.clips: [{id, name, datei, breite, hoehe, dauer, hatTon, gesichter, transkribiert, arbeitskopie}]
  // a.schnitt: [{clip, von, bis}] – siehe schnitt.mjs. Aufträge von früher (nur a.quelle) gelten als ein Clip.

  clips(a) {
    if (a.clips) return a.clips;
    return a.quelle ? [{ id: "c1", name: a.titel ?? "Video", ...a.quelle, gesichter: a.gesichter }] : [];
  }

  schnitt(a) {
    return a.schnitt ?? this.clips(a).map(ganzerClip);
  }

  clip(a, id) {
    const c = this.clips(a).find((x) => x.id === id);
    if (!c) throw new Error("Diesen Clip gibt es nicht.");
    return c;
  }

  /** Maße fürs Zielformat „original“: der erste Clip im Schnitt. */
  ersterClip(a) {
    const schnitt = this.schnitt(a);
    return this.clips(a).find((c) => c.id === schnitt[0]?.clip) ?? this.clips(a)[0];
  }

  #clipsSpeichern(a, clips, schnitt = this.schnitt(a)) {
    // Der erste Teil hat keinen Vorgänger, also keinen Übergang (z. B. nachdem ein Clip gelöscht wurde)
    if (schnitt[0]?.uebergang) {
      const { uebergang, ...erster } = schnitt[0];
      schnitt = [erster, ...schnitt.slice(1)];
    }
    const erster = clips.find((c) => c.id === schnitt[0]?.clip) ?? clips[0];
    this.aendern(a, { clips, schnitt, quelle: erster ? { datei: erster.datei, breite: erster.breite, hoehe: erster.hoehe, dauer: schnittDauer(schnitt), hatTon: clips.some((c) => c.hatTon) } : null });
  }

  /** Neuer Clip (Datei liegt schon im Auftragsordner); hängt ihn ganz ans Ende des Schnitts. */
  async clipHinzufuegen(a, datei, name = path.basename(datei)) {
    const info = await untersuche(datei);
    if (!(info.dauer > 0.2)) throw new Error("Das Video ist zu kurz oder lässt sich nicht lesen.");
    const clips = [...this.clips(a)];
    const bisher = clips.length ? this.schnitt(a) : [];
    const id = `c${clips.reduce((n, c) => Math.max(n, Number(c.id.slice(1)) || 0), 0) + 1}`;
    const clip = { id, name: String(name).slice(0, 80), datei, breite: info.breite, hoehe: info.hoehe, dauer: info.dauer, hatTon: info.hatTon };
    clips.push(clip);
    this.#clipsSpeichern(a, clips, [...bisher, ganzerClip(clip)]);
    return clip;
  }

  clipEntfernen(a, id) {
    const clips = this.clips(a).filter((c) => c.id !== id);
    if (!clips.length) throw new Error("Der letzte Clip bleibt – sonst den ganzen Beitrag verwerfen.");
    const schnitt = this.schnitt(a).filter((t) => t.clip !== id);
    this.#clipsSpeichern(a, clips, schnitt.length ? schnitt : clips.map(ganzerClip));
    this.cuesSchreiben(a, this.cues(a).filter((c) => c.clip !== id));
  }

  schnittSetzen(a, schnitt) {
    this.#clipsSpeichern(a, this.clips(a), schnitt);
    this.aendern(a, { transkript: volltext(this.ausgabeCues(a)), geaendert: true });
  }

  #clipAendern(a, id, felder) {
    this.#clipsSpeichern(a, this.clips(a).map((c) => (c.id === id ? { ...c, ...felder } : c)));
  }

  untertitelDatei(a) {
    return path.join(a.ordner, "untertitel.json");
  }

  /** Untertitel in Clip-Zeit: [{clip, start, end, text}] (ms). Frühere Aufträge hatten eine SRT. */
  cues(a) {
    try {
      return JSON.parse(fs.readFileSync(this.untertitelDatei(a), "utf8"));
    } catch {}
    try {
      return parseSrt(fs.readFileSync(path.join(a.ordner, "untertitel.srt"), "utf8")).map((c) => ({ clip: "c1", ...c }));
    } catch {
      return [];
    }
  }

  cuesSchreiben(a, cues) {
    fs.writeFileSync(this.untertitelDatei(a), JSON.stringify(cues));
    const aus = schnittCues(cues, this.schnitt(a));
    this.aendern(a, { hatUntertitel: aus.length > 0, transkript: volltext(aus) });
  }

  /** Untertitel im fertigen Schnitt. */
  ausgabeCues(a) {
    return schnittCues(this.cues(a), this.schnitt(a));
  }

  /** SRT des fertigen Schnitts (zum Herunterladen, für Plattformen mit eigenen Untertiteln). */
  srtFuerAusgabe(a) {
    const datei = path.join(a.ordner, "untertitel.srt");
    fs.writeFileSync(datei, formatSrt(this.ausgabeCues(a)));
    return datei;
  }

  /** Hochgeladene SRT (Zeiten im fertigen Schnitt) übernehmen. @returns Anzahl */
  srtUebernehmen(a, text) {
    const cues = cuesZurueck(parseSrt(text), this.schnitt(a));
    // Untertitel der herausgeschnittenen Stellen bleiben, falls man den Schnitt wieder ändert
    const sichtbar = new Set(this.ausgabeCues(a).map((c) => c.index));
    const bleiben = this.cues(a).filter((_, i) => !sichtbar.has(i));
    this.cuesSchreiben(a, [...bleiben, ...cues]);
    return cues.length;
  }

  korrigieren(a, korrekturen) {
    this.cuesSchreiben(a, wendeKorrekturenAn(this.cues(a), korrekturen));
  }

  /** Hintergrundmusik setzen (Datei liegt schon im Auftragsordner und ist geprüft). */
  async musikSetzen(a, datei, name) {
    const { dauer } = await tonUntersuchen(datei);
    const alt = a.e.ton?.musik;
    const ton = { ...(a.e.ton ?? {}), musik: { datei, name: String(name).slice(0, 80), dauer, lautstaerke: alt?.lautstaerke ?? 0.25, ducking: alt?.ducking ?? true, ab: 0 } };
    this.aendern(a, { e: { ...a.e, ton }, geaendert: true });
    if (alt?.datei && alt.datei !== datei) await fsp.rm(alt.datei, { force: true });
  }

  /** Video ist da: als ersten Clip annehmen. */
  async videoAnnehmen(a, datei, notizen = "", name) {
    await this.clipHinzufuegen(a, datei, name);
    this.aendern(a, { notizen });
  }

  // ---------- Analyse (je Clip, einmal) ----------

  async #untertitelFuerClip(a, clip, schritt) {
    if (!this.config.whisper || !clip.hatTon || clip.transkribiert) return;
    await schritt(`🎙️ Spracherkennung${this.clips(a).length > 1 ? ` (${clip.name})` : ""} …`);
    const wav = path.join(a.ordner, `ton-${clip.id}.wav`);
    await tonFuerWhisper(clip.datei, wav);
    const neu = await transkribiere(wav, this.config.whisper, this.config.glossar);
    await fsp.rm(wav, { force: true });
    this.cuesSchreiben(a, [...this.cues(a).filter((c) => c.clip !== clip.id), ...neu.map((c) => ({ clip: clip.id, ...c }))]);
    this.#clipAendern(a, clip.id, { transkribiert: true });
  }

  async untertitelErkennen(a, schritt = () => {}) {
    for (const clip of this.clips(a)) await this.#untertitelFuerClip(a, clip, schritt);
  }

  /** Gesichter suchen (einmal je Clip); die Lage wird beim Bauen fürs Zielformat bestimmt. */
  async gesichterSuchen(a, schritt = () => {}) {
    if (!this.gesichtAktiv) return;
    for (const clip of this.clips(a)) {
      if (clip.gesichter !== undefined) continue;
      await schritt("🙂 Suche Gesichter, damit die Untertitel sie nicht verdecken …");
      this.#clipAendern(a, clip.id, { gesichter: await gesichtSuchen(clip.datei, this.config.gesicht) });
    }
  }

  /** Arbeitskopie (fürs Abspielen und Schneiden im Browser), Filmstreifen und Tonwelle je Clip. */
  async arbeitskopienErstellen(a, schritt = () => {}) {
    for (const clip of this.clips(a)) {
      if (clip.arbeitskopie && fs.existsSync(clip.arbeitskopie.video)) continue;
      await schritt(`🎞️ Bereite ${this.clips(a).length > 1 ? `„${clip.name}“` : "das Video"} zum Schneiden vor …`);
      const ordner = path.join(a.ordner, "clips", clip.id);
      await fsp.mkdir(ordner, { recursive: true });
      this.#clipAendern(a, clip.id, { arbeitskopie: await arbeitskopie(clip, ordner) });
    }
  }

  /** Spracherkennung und Gesichtssuche (im Browser auch Arbeitskopien); scheitert die Spracherkennung, geht es ohne Untertitel weiter. */
  async analysieren(a, schritt = () => {}, { arbeitskopien = false } = {}) {
    const warnungen = [];
    if (arbeitskopien) await this.arbeitskopienErstellen(a, schritt);
    if (a.e.untertitel) {
      try {
        await this.untertitelErkennen(a, schritt);
      } catch (e) {
        console.error(`Auftrag ${a.id}: Spracherkennung`, e);
        warnungen.push(`Spracherkennung fehlgeschlagen, das Video kommt ohne automatische Untertitel: ${e.message.slice(0, 400)}`);
        if (!this.cues(a).length) {
          a.e.untertitel = false;
          this.aendern(a, { e: a.e });
        }
      }
    }
    await this.gesichterSuchen(a, schritt);
    return warnungen;
  }

  async captionErzeugen(a, hinweis = "") {
    const material = { art: a.art, transkript: a.transkript ?? "", notizen: a.notizen ?? "", bisher: a.caption ?? "", bilder: [] };
    if (a.art === "sharepic") material.notizen = [a.e.claim, a.e.text, a.notizen].filter(Boolean).join("\n");
    if (this.config.caption.anbieter && a.art === "sharepic" && a.e.bild) {
      const ki = path.join(a.ordner, "ki.jpg");
      await fotoFuerKi(a.e.bild, ki);
      material.bilder.push(ki);
    }
    const o = { ...this.config.caption, absender: a.absender, hashtags: a.hashtags };
    const v = await captionVorschlag(material, o, hinweis);
    // Für Sharepics ohne KI: Claim und Erklärtext als Text, dazu die Hashtags
    let text = v.text;
    if (a.art === "sharepic" && v.quelle !== "ki") text = [a.e.claim, a.e.text, a.hashtags].filter(Boolean).join("\n\n");
    this.aendern(a, {
      caption: text,
      captions: {},
      captionHinweis: v.fehler ? `KI nicht erreichbar (${v.fehler}) – einfacher Vorschlag.` : "",
    });
  }

  // ---------- Bauen ----------

  #design(e) {
    const schema = farbschema(e.design);
    const logo = e.logo === "kein" ? null : logoNachId(this.ppicng, e.logo);
    if (e.logo !== "kein" && !logo) throw new Error(`Logo „${e.logo}“ gibt es in ppicng nicht.`);
    return { schema, logo };
  }

  /** Sharepic als PNG – für die Vorschau in der Web-Version auch mit anderen Einstellungen als gespeichert. */
  async sharepicPng(a, e = a.e) {
    const { schema, logo } = this.#design(e);
    const masse = FORMATE[e.sharepicFormat] ?? FORMATE["1:1"];
    const png = e.bild && e.bildStil === "logo"
      ? await fotoMitLogo({ ...masse, bild: e.bild, logo, schema, logoBreite: e.logoBreite, stil: e.logoStil, position: e.logoPosition })
      : await sharepic({ ...masse, schema, claim: e.claim, text: e.text, logo, bild: e.bild, bildPosition: e.bild ? (e.bildStil === "hintergrund" ? "hintergrund" : undefined) : undefined });
    return { png, masse };
  }

  /** Titelkarte oder Abspann eines Videos als PNG in dessen Zielformat. */
  async kartePng(a, art, e = a.e) {
    const { schema, logo } = this.#design(e);
    const masse = zielMasse(e.format, this.ersterClip(a));
    const k = art === "titelkarte" ? e.titelkarte : (e.abspann ?? { claim: e.abspannText });
    if (!k) return null;
    return k.bild ? eigenesBild({ ...masse, bild: k.bild, schema }) : sharepic({ ...masse, schema, claim: k.claim ?? "", text: k.text ?? "", logo });
  }

  /** Teile für ffmpeg: Datei und Maße des Clips je Teil. */
  #teile(a) {
    const clips = new Map(this.clips(a).map((c) => [c.id, c]));
    // Alles vom Teil mitnehmen: Lautstärke, stumm, Übergang
    return this.schnitt(a).map((t) => ({ ...t, datei: clips.get(t.clip).datei, quelle: clips.get(t.clip) }));
  }

  /** Untertitel als ASS für das Zielformat, samt Lage (automatisch nach Gesicht oder gewählt). */
  async #untertitel(a, e, schema, masse, ordner) {
    const benutzt = new Set(this.schnitt(a).map((t) => t.clip));
    const quellen = this.clips(a).filter((c) => benutzt.has(c.id)).map((c) => ({ funde: c.gesichter, quelle: c }));
    const lage = lageFuer({ e, quellen, masse });
    const cues = e.untertitel ? this.ausgabeCues(a) : [];
    if (!cues.length) return { ass: null, lage };
    const ass = path.join(ordner, "untertitel.ass");
    const box = e.untertitelStil === "box";
    await fsp.writeFile(ass, zuAss(cues, {
      ...masse,
      schrift: "DejaRip",
      farbe: box ? schema.schrift : "#FFFFFF",
      rand: box ? schema.hintergrund : "#000000",
      stil: e.untertitelStil,
      position: 0.33,
      positionQuer: 0.08,
      lage: lage.lage === "unten" ? undefined : lage.lage,
      zeilen: 1,
    }));
    return { ass, lage };
  }

  /** Fertige Datei bauen (Video oder PNG) samt Vorschau. Gehört in die Warteschlange. */
  async bauen(a, schritt = () => {}) {
    const { schema, logo } = this.#design(a.e);
    if (a.art === "sharepic") {
      const { png, masse } = await this.sharepicPng(a);
      const datei = path.join(a.ordner, "sharepic.png");
      await fsp.writeFile(datei, png);
      this.aendern(a, { ergebnis: datei, vorschauDatei: datei, masse, geaendert: false, status: "bereit", medium: null });
    } else {
      await schritt(`🎬 Baue das Video${this.wartend > 1 ? ` (in der Warteschlange: ${this.wartend - 1} vor dir)` : ""} …`);
      if (a.e.untertitel) await this.untertitelErkennen(a, schritt);
      const masse = zielMasse(a.e.format, this.ersterClip(a));
      const { ass, lage } = await this.#untertitel(a, a.e, schema, masse, a.ordner);
      const ausgabe = path.join(a.ordner, "fertig.mp4");
      await schritt(`🎬 Baue das Video (${Math.round(schnittDauer(this.schnitt(a)))} s) …`);
      const fertig = await rendern({
        teile: this.#teile(a), ausgabe, e: { ...a.e, untertitelLage: lage.lage }, schema, logo, ass,
        fontsDir: path.dirname(this.ppicng.schriften.fett), zeiten: this.config.zeiten, video: this.config.video,
      });
      await schritt("📦 Fast fertig …");
      const klein = path.join(a.ordner, "vorschau.mp4");
      await vorschau(ausgabe, klein);
      const info = await untersuche(ausgabe);
      this.aendern(a, {
        ergebnis: ausgabe, vorschauDatei: klein, masse: fertig, dauer: info.dauer, geaendert: false, status: "bereit", medium: null,
        lage: lage.lage, lageAutomatisch: lage.automatisch, gesichtHinweise: lage.hinweise,
      });
    }
    if (this.config.ausgabeOrdner) {
      await fsp.mkdir(this.config.ausgabeOrdner, { recursive: true });
      const name = `${new Date().toISOString().slice(0, 10)}-${a.id}${path.extname(a.ergebnis)}`;
      await fsp.copyFile(a.ergebnis, path.join(this.config.ausgabeOrdner, name));
    }
  }

  /**
   * Ein Standbild des fertigen Videos mit den Einstellungen `e` (ohne Titelkarte und Abspann) – an der Stelle
   * `zeit` des Schnitts oder dort, wo die Bauchbinde ganz zu sehen ist. Gehört in die Warteschlange.
   */
  async standbild(a, e = a.e, zeit = null) {
    const { schema, logo } = this.#design(e);
    const ordner = path.join(a.ordner, "standbild");
    await fsp.mkdir(ordner, { recursive: true });
    const masse = zielMasse(e.format, this.ersterClip(a));
    const { ass, lage } = await this.#untertitel(a, e, schema, masse, ordner);
    const dauer = schnittDauer(this.schnitt(a));
    const sekunde = Math.min(Math.max(0, dauer - 0.1), Math.max(0, zeit ?? this.config.zeiten.bauchbindeStart + 1.2));
    // Nur die Teile bis zur gewünschten Stelle dekodieren
    const teile = this.#teile(a);
    const ort = imClip(this.schnitt(a), sekunde);
    const bis = teile.slice(0, (ort?.index ?? 0) + 1);
    const ausgabe = path.join(ordner, "standbild.jpg");
    const { args } = await renderArgs({
      teile: bis, ausgabe, e: { ...e, titelkarte: null, abspannAn: false, untertitelLage: lage.lage },
      schema, logo, ass, fontsDir: path.dirname(this.ppicng.schriften.fett), zeiten: this.config.zeiten, video: this.config.video,
      standbild: sekunde,
    });
    await ausfuehren("ffmpeg", args, { cwd: ordner });
    return { datei: ausgabe, lage };
  }

  // ---------- Postiz ----------

  async alleKanaele() {
    if (!this.postiz) return [];
    if (Date.now() - this.kanalCache.zeit > 5 * 60e3) this.kanalCache = { zeit: Date.now(), liste: await this.postiz.kanaele() };
    return this.kanalCache.liste;
  }

  /** Kanäle des gewählten Kunden, die zur Art des Beitrags passen. */
  async kanaeleFuer(a) {
    return passendeKanaele(kanaeleVonKunde(await this.alleKanaele(), a.kunde), a.art === "video" ? "video" : "foto");
  }

  async standardKanaele(a) {
    const moeglich = await this.kanaeleFuer(a);
    const liste = this.config.postiz.kanaele;
    const vorgabe = liste.length ? moeglich.filter((c) => liste.some((e) => passtZu(c, e))) : moeglich;
    return (vorgabe.length ? vorgabe : moeglich).map((c) => c.id);
  }

  async kanaeleVorwaehlen(a) {
    if (!this.postiz || a.kanaele) return;
    try {
      const kunde = a.kundeName ? findeKunde(await this.alleKanaele(), a.kundeName) : null;
      this.aendern(a, { kunde: kunde?.id ?? null });
      this.aendern(a, { kanaele: await this.standardKanaele(a) });
    } catch (e) {
      this.aendern(a, { kanaele: [], captionHinweis: `Postiz nicht erreichbar: ${e.message}` });
    }
  }

  /** Zu lange Texte je Kanal; null, wenn alles passt. */
  zuLang(a, kanaele) {
    const eigene = this.postiz.eigeneEinstellungen();
    const probleme = [];
    for (const c of kanaele) {
      const max = zeichenLimit(c, eigene);
      const n = zeichenZahl(a.captions?.[c.id] ?? a.caption, c.identifier);
      if (max && n > max) probleme.push({ c, n, max });
    }
    return probleme.length ? probleme : null;
  }

  /**
   * Hochladen und posten bzw. planen. Wirft bei Fehlern; vorher prüfen: zuLang(), wiederFrei().
   * @returns {Promise<{kanaele:object[]}>}
   */
  async posten(a, zeit) {
    const kanaele = (await this.alleKanaele()).filter((c) => a.kanaele.includes(c.id));
    if (!kanaele.length) throw new Error("Keine Kanäle gewählt.");
    const medium = a.medium ?? (await this.postiz.hochladen(a.ergebnis));
    this.aendern(a, { medium });
    const ergebnis = await this.postiz.beitrag({
      typ: zeit ? "schedule" : "now", zeit: zeit ?? new Date(), caption: a.caption, captions: a.captions ?? {}, medien: [medium], kanaele,
    });
    this.aendern(a, { status: zeit ? "geplant" : "gepostet", postiz: ergebnis, plan: zeit ? { zeit: zeit.toISOString() } : null });
    return { kanaele };
  }

  /** null, wenn Postiz jetzt genug Anfragen frei hat, sonst ab wann (Infinity: nie). */
  wiederFrei(a) {
    return this.zaehler.wiederFrei(Postiz.bedarf({ medien: 1, hochgeladen: Boolean(a.medium), story: false, kanaele: [] }));
  }
}
