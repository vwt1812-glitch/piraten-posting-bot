// Telegram als Plattform: schlanker Client für die Bot API (https://core.telegram.org/bots/api)
// und Übersetzung in die gemeinsamen Ereignisse des Bots (siehe plattform/index.mjs).
// Mit eigenem Bot-API-Server (TELEGRAM_API_URL, Start mit --local) gehen Dateien bis 2 GB,
// über api.telegram.org nur 20 MB herunter und 50 MB hoch.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MB = 1024 * 1024;

/** Knöpfe [[{text, daten}]] bzw. Links [[{text, url}]] → inline_keyboard */
export const tastatur = (knoepfe) =>
  knoepfe?.length ? { reply_markup: { inline_keyboard: knoepfe.map((reihe) => reihe.map((k) => (k.url ? { text: k.text, url: k.url } : { text: k.text, callback_data: k.daten }))) } } : {};

/** Update der Bot API → Ereignis des Bots (oder null, wenn es den Bot nicht interessiert). */
export function ereignisAus(update) {
  const basis = (m, von) => ({
    plattform: "telegram",
    chat: String(m.chat.id),
    nutzer: String(von.id),
    nutzerName: [von.first_name, von.last_name].filter(Boolean).join(" ") || von.username || String(von.id),
    gruppe: m.chat.type !== "private",
  });
  if (update.callback_query) {
    const q = update.callback_query;
    if (!q.message) return null;
    return { ...basis(q.message, q.from), typ: "knopf", daten: q.data, nachricht: String(q.message.message_id), rueckmeldung: q.id };
  }
  const m = update.message;
  if (!m?.from) return null;
  let medium = null;
  if (m.video) medium = { art: "video", ref: m.video.file_id, name: m.video.file_name ?? "video.mp4", groesse: m.video.file_size };
  else if (m.video_note) medium = { art: "video", ref: m.video_note.file_id, name: "video.mp4", groesse: m.video_note.file_size };
  else if (m.animation) medium = { art: "video", ref: m.animation.file_id, name: m.animation.file_name ?? "video.mp4", groesse: m.animation.file_size };
  else if (m.photo?.length) {
    const f = m.photo.at(-1);
    medium = { art: "foto", ref: f.file_id, name: "foto.jpg", groesse: f.file_size };
  } else if (m.document) {
    const d = m.document;
    const mime = d.mime_type ?? "";
    const art = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "foto" : "datei";
    medium = { art, ref: d.file_id, name: d.file_name ?? "datei", groesse: d.file_size, mime };
  }
  const text = (m.text ?? m.caption ?? "").trim();
  if (!medium && !text) return null;
  return { ...basis(m, m.from), typ: medium ? "medium" : "text", text, medium, nachricht: String(m.message_id) };
}

export class TelegramPlattform {
  name = "telegram";

  constructor({ token, api, erlaubt }) {
    this.token = token;
    this.api = api;
    this.erlaubtListe = erlaubt;
    this.lokal = !api.includes("api.telegram.org");
    this.maxDownload = this.lokal ? 2000 * MB : 20 * MB;
    this.maxUpload = this.lokal ? 2000 * MB : 50 * MB;
  }

  async aufruf(methode, params = {}) {
    const istForm = params instanceof FormData;
    const res = await fetch(`${this.api}/bot${this.token}/${methode}`, {
      method: "POST",
      headers: istForm ? {} : { "Content-Type": "application/json" },
      body: istForm ? params : JSON.stringify(params),
    });
    const json = await res.json();
    if (!json.ok) {
      const fehler = new Error(`Telegram ${methode}: ${json.description}`);
      fehler.code = json.error_code;
      throw fehler;
    }
    return json.result;
  }

  async verbinden() {
    const ich = await this.aufruf("getMe");
    this.ich = ich;
    await this.aufruf("setMyCommands", {
      commands: [
        { command: "start", description: "Hilfe und Überblick" },
        { command: "sharepic", description: "Sharepic im ppicng-Design: /sharepic Claim" },
        { command: "logo", description: "Logos aus ppicng suchen: /logo Bayern" },
        { command: "status", description: "Postiz, ffmpeg, Whisper und KI prüfen" },
        { command: "id", description: "Chat- und Nutzer-ID anzeigen" },
        { command: "abbrechen", description: "laufende Eingabe beenden" },
      ],
    }).catch(() => {});
    return `@${ich.username}`;
  }

  /** Personen oder Gruppen aus TELEGRAM_ERLAUBT. */
  erlaubt(e) {
    return this.erlaubtListe.includes(e.nutzer) || this.erlaubtListe.includes(e.chat);
  }

  /** Lange Abfrage; ruft `verarbeiten` für jedes Ereignis auf (Fehler darin halten die Schleife nicht an). */
  async lauschen(verarbeiten) {
    let offset = 0;
    for (;;) {
      let updates;
      try {
        updates = await this.aufruf("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      } catch (e) {
        console.error("Telegram getUpdates:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        const e = ereignisAus(u);
        if (!e) continue;
        if (e.typ === "knopf") this.aufruf("answerCallbackQuery", { callback_query_id: e.rueckmeldung }).catch(() => {});
        verarbeiten(e);
      }
    }
  }

  async senden(chat, html, { knoepfe } = {}) {
    const m = await this.aufruf("sendMessage", { chat_id: chat, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...tastatur(knoepfe) });
    return String(m.message_id);
  }

  async bearbeiten(chat, nachricht, html, { knoepfe } = {}) {
    try {
      await this.aufruf("editMessageText", {
        chat_id: chat, message_id: Number(nachricht), text: html, parse_mode: "HTML",
        link_preview_options: { is_disabled: true }, ...tastatur(knoepfe),
      });
      return nachricht;
    } catch (e) {
      if (/message is not modified/.test(e.message)) return nachricht;
      // Zu alt oder gelöscht: neu schicken
      if (/message to edit not found|message can't be edited/.test(e.message)) return this.senden(chat, html, { knoepfe });
      throw e;
    }
  }

  async #datei(chat, methode, feld, datei, extra = {}) {
    const form = new FormData();
    form.append("chat_id", String(chat));
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    form.append(feld, await fs.openAsBlob(datei), path.basename(datei));
    const m = await this.aufruf(methode, form);
    return String(m.message_id);
  }

  video(chat, datei, { text, breite, hoehe, dauer } = {}) {
    return this.#datei(chat, "sendVideo", "video", datei, {
      caption: text, parse_mode: text ? "HTML" : undefined, supports_streaming: "true",
      width: breite ? String(breite) : undefined, height: hoehe ? String(hoehe) : undefined,
      duration: dauer ? String(Math.round(dauer)) : undefined,
    });
  }

  bild(chat, datei, { text } = {}) {
    return this.#datei(chat, "sendPhoto", "photo", datei, { caption: text, parse_mode: text ? "HTML" : undefined });
  }

  dokument(chat, datei, { text } = {}) {
    return this.#datei(chat, "sendDocument", "document", datei, { caption: text, parse_mode: text ? "HTML" : undefined });
  }

  async herunterladen(medium, ziel) {
    if (medium.groesse && medium.groesse > this.maxDownload) {
      throw new Error(`Die Datei ist ${Math.round(medium.groesse / MB)} MB groß – über api.telegram.org gehen nur 20 MB. Lokalen Bot-API-Server einrichten (siehe README) oder das Video über Matrix schicken.`);
    }
    const info = await this.aufruf("getFile", { file_id: medium.ref });
    // Lokaler Bot-API-Server liefert einen absoluten Pfad auf der Platte
    if (path.isAbsolute(info.file_path)) {
      await fsp.copyFile(info.file_path, ziel);
      return;
    }
    const res = await fetch(`${this.api}/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(ziel));
  }
}
