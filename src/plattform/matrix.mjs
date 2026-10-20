// Matrix als Plattform über die Client-Server-API, ohne SDK. Das Bot-Konto kann auf einem beliebigen Server liegen
// (z. B. matrix.org) – über die Föderation lädt man es trotzdem in Räume auf matrix.piratenpartei.de ein.
// https://spec.matrix.org/latest/client-server-api/
//
// Matrix kennt keine Knöpfe wie Telegram. Der Bot schreibt die Auswahl deshalb nummeriert unter die
// Nachricht und setzt selbst die Reaktionen 1️⃣ 2️⃣ 3️⃣ … darunter – antippen genügt. Alternativ die Zahl
// als Nachricht schicken („3“). Ein neues Menü ersetzt das alte (das wird gelöscht), damit der Raum
// übersichtlich bleibt.
//
// Verschlüsselte Räume versteht der Bot selbst nicht. Entweder einen unverschlüsselten Raum nehmen
// (Raumeinstellungen → Sicherheit; bei neuen Räumen vor dem Anlegen ausschalten) oder den Bot über
// pantalaimon (https://github.com/matrix-org/pantalaimon) anbinden – siehe README.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MB = 1024 * 1024;
export const ZIFFERN = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 30, types: ["m.room.message", "m.reaction", "m.room.encrypted"] },
    state: { types: ["m.room.member"], lazy_load_members: true },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

/** Das kleine HTML der Bot-Texte (wie bei Telegram: b, i, code, pre, a) als Klartext. */
export function htmlZuText(html) {
  return String(html)
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/g, (_, url, t) => (t === url ? url : `${t} (${url})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Knöpfe [[{text, daten}]] als Liste untereinander, nummeriert. */
export function menuListe(knoepfe) {
  return (knoepfe ?? []).flat().filter((k) => !k.url).map((k, i) => ({ ...k, zeichen: ZIFFERN[i] ?? `${i + 1}.` }));
}

/** Nachrichteninhalt samt nummeriertem Menü. */
export function inhalt(html, knoepfe) {
  const liste = menuListe(knoepfe);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Links (z. B. „Im Browser schneiden“) stehen ohne Nummer darunter
  const links = (knoepfe ?? []).flat().filter((k) => k.url);
  const zeilen = [...liste.map((k) => `${k.zeichen} ${k.text}`), ...links.map((k) => `${k.text}: ${k.url}`)];
  const body = htmlZuText(html) + (zeilen.length ? `\n\n${zeilen.join("\n")}` : "");
  const formatted = html.replace(/\n/g, "<br>") + (zeilen.length
    ? `<br><br>${[...liste.map((k) => `${k.zeichen} ${esc(k.text)}`), ...links.map((k) => `<a href="${esc(k.url)}">${esc(k.text)}</a>`)].join("<br>")}`
    : "");
  return { msgtype: "m.text", body, format: "org.matrix.custom.html", formatted_body: formatted };
}

/** Antwort-Zitat (Fallback „> <@x> …“) vom eigentlichen Text trennen. */
export function ohneZitat(text) {
  return String(text ?? "").replace(/^(> .*\n?)+\n?/, "").trim();
}

/** Darf diese Person oder dieser Raum? Einträge: @name:server, !raum:server, *:server */
export function istErlaubt(liste, nutzer, raum) {
  return liste.some((eintrag) => {
    if (eintrag.startsWith("*:")) return nutzer.endsWith(eintrag.slice(1));
    return eintrag === nutzer || eintrag === raum;
  });
}

/** Adresse des Servers aus der Matrix-ID: /.well-known/matrix/client, sonst https://server. */
export async function serverFinden(server) {
  try {
    const res = await fetch(`https://${server}/.well-known/matrix/client`, { signal: AbortSignal.timeout(10000) });
    const url = res.ok ? (await res.json())?.["m.homeserver"]?.base_url : null;
    if (typeof url === "string" && /^https:\/\//.test(url)) return url.replace(/\/$/, "");
  } catch {}
  return `https://${server}`;
}

const MEDIEN = { "m.video": "video", "m.image": "foto", "m.audio": "ton", "m.file": "datei" };

/**
 * Timeline-Event → Ereignis des Bots. `menues`: eventId → {daten: string[]}, `letztes`: Raum → eventId.
 */
export function ereignisAus(ev, raum, { ich, menues, letztes }) {
  if (ev.sender === ich) return null;
  const basis = { plattform: "matrix", chat: raum, nutzer: ev.sender, nutzerName: ev.sender, gruppe: true };
  const c = ev.content ?? {};
  if (ev.type === "m.room.encrypted") return { ...basis, typ: "verschluesselt" };
  if (ev.type === "m.reaction") {
    const rel = c["m.relates_to"];
    const menu = rel?.rel_type === "m.annotation" ? menues.get(rel.event_id) : null;
    if (!menu) return null;
    const i = ZIFFERN.indexOf(rel.key);
    const daten = menu.daten[i];
    return daten ? { ...basis, typ: "knopf", daten, nachricht: rel.event_id } : null;
  }
  if (ev.type !== "m.room.message" || c["m.relates_to"]?.rel_type === "m.replace") return null;
  const art = MEDIEN[c.msgtype];
  if (art) {
    const mime = c.info?.mimetype ?? "";
    const echteArt = art === "datei" ? (mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "foto" : mime.startsWith("audio/") ? "ton" : "datei") : art;
    if (!c.url && c.file) return { ...basis, typ: "verschluesselt" };
    const name = c.filename ?? c.body ?? "datei";
    // Bildunterschrift (MSC2530): body ist der Text, filename der Dateiname
    const text = c.filename && c.body && c.body !== c.filename ? c.body.trim() : "";
    return { ...basis, typ: "medium", text, medium: { art: echteArt, ref: c.url, name, groesse: c.info?.size, mime }, nachricht: ev.event_id };
  }
  if (!["m.text", "m.notice"].includes(c.msgtype)) return null;
  const text = ohneZitat(c.body);
  if (!text) return null;
  const e = { ...basis, typ: "text", text, nachricht: ev.event_id };
  // „3“ als Antwort auf das letzte Menü im Raum
  const zahl = text.match(/^(\d{1,2})\.?$/);
  const menu = zahl && menues.get(letztes.get(raum));
  if (menu?.daten[Number(zahl[1]) - 1]) e.auswahl = menu.daten[Number(zahl[1]) - 1];
  return e;
}

export class MatrixPlattform {
  name = "matrix";

  constructor({ url, server, token, nutzer, passwort, erlaubt, einladungenAnnehmen }, datenDir) {
    this.url = url;
    this.server = server;
    this.token = token;
    this.nutzer = nutzer;
    this.passwort = passwort;
    this.erlaubtListe = erlaubt;
    this.einladungenAnnehmen = einladungenAnnehmen;
    this.zustandDatei = path.join(datenDir, "matrix.json");
    fs.mkdirSync(datenDir, { recursive: true });
    this.zustand = fs.existsSync(this.zustandDatei) ? JSON.parse(fs.readFileSync(this.zustandDatei, "utf8")) : {};
    this.menues = new Map(Object.entries(this.zustand.menues ?? {}));
    this.letztes = new Map(Object.entries(this.zustand.letztes ?? {}));
    this.verschluesseltGemeldet = new Set();
    this.txn = 0;
    this.maxUpload = 50 * MB;
    this.maxDownload = Infinity;
  }

  #speichern() {
    // Nur die letzten 300 Menüs merken
    const menues = [...this.menues].slice(-300);
    this.menues = new Map(menues);
    this.zustand.menues = Object.fromEntries(menues);
    this.zustand.letztes = Object.fromEntries(this.letztes);
    fs.writeFileSync(this.zustandDatei, JSON.stringify(this.zustand));
  }

  async anfrage(methode, pfad, body, { query, roh = false, typ, versuch = 0 } = {}) {
    const adresse = `${this.url}${pfad}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const istDaten = body instanceof Blob || body instanceof Uint8Array;
    const res = await fetch(adresse, {
      method: methode,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "Content-Type": typ ?? "application/json" } : {}),
      },
      body: body === undefined ? undefined : istDaten ? body : JSON.stringify(body),
    });
    if (res.status === 429 && versuch < 3) {
      const json = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(json.retry_after_ms ?? 2000, 30000)));
      return this.anfrage(methode, pfad, body, { query, roh, typ, versuch: versuch + 1 });
    }
    if (roh) return res;
    const text = await res.text();
    if (!res.ok) {
      const fehler = new Error(`Matrix ${methode} ${pfad}: ${res.status} ${text.slice(0, 300)}`);
      fehler.status = res.status;
      throw fehler;
    }
    return text ? JSON.parse(text) : {};
  }

  async verbinden() {
    this.url ||= await serverFinden(this.server);
    this.token ||= this.zustand.token;
    if (!this.token) {
      const antwort = await this.anfrage("POST", "/_matrix/client/v3/login", {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: this.nutzer },
        password: this.passwort,
        initial_device_display_name: "Piraten-Posting-Bot",
      });
      this.token = antwort.access_token;
      this.zustand.token = antwort.access_token;
      this.#speichern();
    }
    let ich;
    try {
      ich = await this.anfrage("GET", "/_matrix/client/v3/account/whoami");
    } catch (e) {
      // Gespeicherter Token abgelaufen: neu anmelden
      if (e.status === 401 && this.zustand.token && this.passwort) {
        this.token = null;
        delete this.zustand.token;
        return this.verbinden();
      }
      throw e;
    }
    this.ich = ich.user_id;
    const config = await this.anfrage("GET", "/_matrix/client/v1/media/config")
      .catch(() => this.anfrage("GET", "/_matrix/media/v3/config"))
      .catch(() => ({}));
    if (config["m.upload.size"]) this.maxUpload = config["m.upload.size"];
    return this.ich;
  }

  erlaubt(e) {
    return istErlaubt(this.erlaubtListe, e.nutzer, e.chat);
  }

  async lauschen(verarbeiten) {
    let since = this.zustand.since;
    if (!since) {
      // Erster Start: alte Nachrichten überspringen
      since = (await this.anfrage("GET", "/_matrix/client/v3/sync", undefined, { query: { filter: FILTER, timeout: "0" } })).next_batch;
    }
    for (;;) {
      let sync;
      try {
        sync = await this.anfrage("GET", "/_matrix/client/v3/sync", undefined, { query: { filter: FILTER, timeout: "30000", since } });
      } catch (e) {
        console.error("Matrix sync:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const [raum, r] of Object.entries(sync.rooms?.invite ?? {})) await this.#einladung(raum, r);
      for (const [raum, r] of Object.entries(sync.rooms?.join ?? {})) {
        for (const ev of r.timeline?.events ?? []) {
          const e = ereignisAus(ev, raum, this);
          if (!e) continue;
          if (e.typ === "verschluesselt") {
            if (!this.verschluesseltGemeldet.has(raum) && this.erlaubt(e)) {
              this.verschluesseltGemeldet.add(raum);
              this.senden(raum, "🔒 Dieser Raum ist verschlüsselt – das kann ich (noch) nicht lesen. Bitte einen unverschlüsselten Raum nehmen oder den Bot über pantalaimon anbinden (siehe README).").catch(() => {});
            }
            continue;
          }
          verarbeiten(e);
        }
      }
      since = sync.next_batch;
      this.zustand.since = since;
      this.#speichern();
    }
  }

  async #einladung(raum, r) {
    const mich = (r.invite_state?.events ?? []).find((ev) => ev.type === "m.room.member" && ev.state_key === this.ich);
    const von = mich?.sender ?? "";
    if (this.einladungenAnnehmen && istErlaubt(this.erlaubtListe, von, raum)) {
      try {
        await this.anfrage("POST", `/_matrix/client/v3/join/${encodeURIComponent(raum)}`, {});
        await this.senden(raum, "Ahoi! 🏴‍☠️ Schick mir ein Video oder schreib <code>/sharepic Dein Claim</code>. Mit <code>/start</code> gibt’s die Hilfe.");
      } catch (e) {
        // Häufigster Grund bei Räumen auf anderen Servern: Raum nicht föderiert („Nur für Mitglieder von …“)
        // oder der Server des Bots per Server-ACL ausgesperrt
        const hinweis = e.status === 403 ? " – Raum anderer Server nicht föderiert oder Server-ACL? Siehe README „Matrix“." : "";
        console.error(`Matrix: Beitritt zu ${raum} (eingeladen von ${von}) fehlgeschlagen:`, e.message + hinweis);
      }
    } else {
      await this.anfrage("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/leave`, {}).catch(() => {});
    }
  }

  async #schicken(raum, typ, content) {
    const txn = `${Date.now()}-${++this.txn}`;
    const { event_id } = await this.anfrage("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/send/${typ}/${txn}`, content);
    return event_id;
  }

  async #reaktionenAnpassen(raum, eventId, anzahl) {
    const menu = this.menues.get(eventId);
    menu.reaktionen ??= {};
    for (const [i, zeichen] of ZIFFERN.entries()) {
      const vorhanden = menu.reaktionen[zeichen];
      if (i < anzahl && !vorhanden) {
        menu.reaktionen[zeichen] = await this.#schicken(raum, "m.reaction", {
          "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: zeichen },
        }).catch(() => null);
      } else if (i >= anzahl && vorhanden) {
        await this.anfrage("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/redact/${encodeURIComponent(vorhanden)}/${Date.now()}-${++this.txn}`, {}).catch(() => {});
        delete menu.reaktionen[zeichen];
      }
    }
  }

  #menuMerken(raum, eventId, knoepfe) {
    const daten = menuListe(knoepfe).map((k) => k.daten);
    const alt = this.menues.get(eventId);
    this.menues.delete(eventId);
    this.menues.set(eventId, { daten, reaktionen: alt?.reaktionen ?? {} });
    if (daten.length) this.letztes.set(raum, eventId);
    this.#speichern();
    return daten.length;
  }

  async senden(raum, html, { knoepfe } = {}) {
    const eventId = await this.#schicken(raum, "m.room.message", inhalt(html, knoepfe));
    const anzahl = this.#menuMerken(raum, eventId, knoepfe);
    if (anzahl) {
      await this.#reaktionenAnpassen(raum, eventId, Math.min(anzahl, ZIFFERN.length));
      this.#speichern();
    }
    return eventId;
  }

  /**
   * Menüs werden neu geschickt (das alte gelöscht): So stehen unter jedem Menü frische Reaktionen,
   * und dieselbe Zahl lässt sich mehrmals hintereinander wählen. Reine Texte werden bearbeitet.
   */
  async bearbeiten(raum, eventId, html, { knoepfe } = {}) {
    if (menuListe(knoepfe).length) {
      const neu = await this.senden(raum, html, { knoepfe });
      this.#loeschen(raum, eventId);
      return neu;
    }
    const neu = inhalt(html, knoepfe);
    await this.#schicken(raum, "m.room.message", {
      ...neu,
      body: `* ${neu.body}`,
      "m.new_content": neu,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
    if (this.menues.has(eventId)) {
      this.#menuMerken(raum, eventId, []);
      await this.#reaktionenAnpassen(raum, eventId, 0);
      this.#speichern();
    }
    return eventId;
  }

  #loeschen(raum, eventId) {
    this.anfrage("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/redact/${encodeURIComponent(eventId)}/${Date.now()}-${++this.txn}`, {}).catch(() => {});
    this.menues.delete(eventId);
    this.#speichern();
  }

  async #hochladen(datei, mime) {
    const groesse = fs.statSync(datei).size;
    if (groesse > this.maxUpload) {
      throw new Error(`Die Datei ist ${Math.round(groesse / MB)} MB groß, der Matrix-Server nimmt höchstens ${Math.round(this.maxUpload / MB)} MB.`);
    }
    const blob = await fs.openAsBlob(datei, { type: mime });
    const { content_uri } = await this.anfrage("POST", "/_matrix/media/v3/upload", blob, { query: { filename: path.basename(datei) }, typ: mime });
    return { url: content_uri, groesse };
  }

  async #medium(raum, msgtype, datei, mime, { text, breite, hoehe, dauer } = {}) {
    const { url, groesse } = await this.#hochladen(datei, mime);
    const name = path.basename(datei);
    const content = {
      msgtype,
      body: text ? htmlZuText(text) : name,
      filename: name,
      url,
      info: { mimetype: mime, size: groesse, ...(breite ? { w: breite, h: hoehe } : {}), ...(dauer ? { duration: Math.round(dauer * 1000) } : {}) },
    };
    if (text) Object.assign(content, { format: "org.matrix.custom.html", formatted_body: text.replace(/\n/g, "<br>") });
    return this.#schicken(raum, "m.room.message", content);
  }

  video(raum, datei, o) {
    return this.#medium(raum, "m.video", datei, "video/mp4", o);
  }

  bild(raum, datei, o) {
    const mime = /\.png$/i.test(datei) ? "image/png" : "image/jpeg";
    return this.#medium(raum, "m.image", datei, mime, o);
  }

  dokument(raum, datei, o) {
    const mime = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".srt": "application/x-subrip" }[path.extname(datei).toLowerCase()] ?? "application/octet-stream";
    return this.#medium(raum, "m.file", datei, mime, o);
  }

  async herunterladen(medium, ziel) {
    const m = String(medium.ref).match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`Unbekannte Medienadresse: ${medium.ref}`);
    const teil = `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
    // Neue Server: authentifizierte Medien (v1), ältere: v3 ohne Anmeldung
    let res = await this.anfrage("GET", `/_matrix/client/v1/media/download/${teil}`, undefined, { roh: true });
    if (!res.ok) res = await this.anfrage("GET", `/_matrix/media/v3/download/${teil}`, undefined, { roh: true });
    if (!res.ok) throw new Error(`Matrix-Download fehlgeschlagen: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(ziel));
  }
}
