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
import { untersuche, tonFuerWhisper, rendern, renderArgs, vorschau, zielMasse, FORMATE, fotoFuerKi, ausfuehren } from "./video.mjs";
import { transkribiere } from "./whisper.mjs";
import { parseSrt, formatSrt, zuAss, volltext } from "./untertitel.mjs";
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

  srtDatei(a) {
    return path.join(a.ordner, "untertitel.srt");
  }

  /** Video ist da: untersuchen und merken. */
  async videoAnnehmen(a, datei, notizen = "") {
    const quelle = await untersuche(datei);
    this.aendern(a, { quelle: { datei, ...quelle }, notizen });
  }

  // ---------- Analyse ----------

  async untertitelErkennen(a, schritt = () => {}) {
    if (!this.config.whisper || !a.quelle?.hatTon) return;
    await schritt("🎙️ Spracherkennung läuft …");
    const wav = path.join(a.ordner, "ton.wav");
    await tonFuerWhisper(a.quelle.datei, wav);
    const cues = await transkribiere(wav, this.config.whisper, this.config.glossar);
    await fsp.rm(wav, { force: true });
    await fsp.writeFile(this.srtDatei(a), formatSrt(cues));
    this.aendern(a, { hatUntertitel: cues.length > 0, transkript: volltext(cues) });
  }

  /** Gesichter im Original suchen (einmal je Video); die Lage wird beim Bauen fürs Zielformat bestimmt. */
  async gesichterSuchen(a, schritt = () => {}) {
    if (!this.gesichtAktiv || a.gesichter !== undefined) return;
    await schritt("🙂 Suche Gesichter, damit die Untertitel sie nicht verdecken …");
    this.aendern(a, { gesichter: await gesichtSuchen(a.quelle.datei, this.config.gesicht) });
  }

  /** Spracherkennung und Gesichtssuche; scheitert die Spracherkennung, geht es ohne Untertitel weiter. */
  async analysieren(a, schritt = () => {}) {
    const warnungen = [];
    if (a.e.untertitel) {
      try {
        await this.untertitelErkennen(a, schritt);
      } catch (e) {
        console.error(`Auftrag ${a.id}: Spracherkennung`, e);
        a.e.untertitel = false;
        this.aendern(a, { e: a.e });
        warnungen.push(`Spracherkennung fehlgeschlagen, das Video kommt ohne Untertitel: ${e.message.slice(0, 400)}`);
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
    const masse = zielMasse(e.format, a.quelle);
    const k = art === "titelkarte" ? e.titelkarte : (e.abspann ?? { claim: e.abspannText });
    if (!k) return null;
    return k.bild ? eigenesBild({ ...masse, bild: k.bild, schema }) : sharepic({ ...masse, schema, claim: k.claim ?? "", text: k.text ?? "", logo });
  }

  /** Untertitel als ASS für das Zielformat, samt Lage (automatisch nach Gesicht oder gewählt). */
  async #untertitel(a, e, schema, masse, ordner) {
    const lage = lageFuer({ e, funde: a.gesichter, quelle: a.quelle, masse });
    if (!e.untertitel || !fs.existsSync(this.srtDatei(a))) return { ass: null, lage };
    const cues = parseSrt(await fsp.readFile(this.srtDatei(a), "utf8"));
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
      if (a.e.untertitel && !fs.existsSync(this.srtDatei(a))) await this.untertitelErkennen(a, schritt);
      const masse = zielMasse(a.e.format, a.quelle);
      const { ass, lage } = await this.#untertitel(a, a.e, schema, masse, a.ordner);
      const ausgabe = path.join(a.ordner, "fertig.mp4");
      const fertig = await rendern({
        eingabe: a.quelle.datei, ausgabe, quelle: a.quelle, e: { ...a.e, untertitelLage: lage.lage }, schema, logo, ass,
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
   * Ein Standbild des fertigen Videos mit den Einstellungen `e` (ohne Titelkarte und Abspann) – schnell genug
   * für die Vorschau in der Web-Version. Gehört in die Warteschlange.
   */
  async standbild(a, e = a.e) {
    const { schema, logo } = this.#design(e);
    const ordner = path.join(a.ordner, "standbild");
    await fsp.mkdir(ordner, { recursive: true });
    const masse = zielMasse(e.format, a.quelle);
    const { ass, lage } = await this.#untertitel(a, e, schema, masse, ordner);
    // Zeitpunkt, an dem die Bauchbinde ganz zu sehen ist und meist schon Untertitel laufen
    const sekunde = Math.min(Math.max(0, a.quelle.dauer - 0.1), this.config.zeiten.bauchbindeStart + 1.2);
    const ausgabe = path.join(ordner, "standbild.jpg");
    const { args } = await renderArgs({
      eingabe: a.quelle.datei, ausgabe, quelle: a.quelle, e: { ...e, titelkarte: null, abspannAn: false, untertitelLage: lage.lage },
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
