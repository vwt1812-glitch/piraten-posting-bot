import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hier = path.dirname(fileURLToPath(import.meta.url));
export const BOT_DIR = path.resolve(hier, "..");

const envDatei = path.join(BOT_DIR, ".env");
if (fs.existsSync(envDatei)) process.loadEnvFile(envDatei);

const env = (name, standard) => {
  const wert = process.env[name]?.trim();
  return wert ? wert : standard;
};
const ja = (name, standard) => !/^(nein|no|false|0|aus)$/i.test(env(name, standard ? "ja" : "nein"));
const liste = (name) => (env(name, "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const pfad = (wert) => (wert ? path.resolve(BOT_DIR, wert) : wert);

process.env.TZ = env("ZEITZONE", "Europe/Berlin");

function captionConfig() {
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const openaiKey = env("OPENAI_API_KEY");
  const anbieter = env("CAPTION_ANBIETER", anthropicKey ? "claude" : openaiKey ? "openai" : "");
  if (anbieter && !["claude", "openai"].includes(anbieter)) throw new Error(`CAPTION_ANBIETER muss claude oder openai sein, nicht „${anbieter}“.`);
  if (anbieter === "claude" && !anthropicKey) throw new Error("CAPTION_ANBIETER=claude braucht ANTHROPIC_API_KEY.");
  if (anbieter === "openai" && !openaiKey) throw new Error("CAPTION_ANBIETER=openai braucht OPENAI_API_KEY.");
  return {
    anbieter: anbieter || null,
    anthropicKey,
    openaiKey,
    openaiUrl: env("OPENAI_BASE_URL"),
    modell: env("CAPTION_MODELL", anbieter === "openai" ? "gpt-5.5" : "claude-opus-5-5"),
    stil: env("CAPTION_STIL", ""),
    hashtags: env("CAPTION_HASHTAGS", "#Piraten"),
    absender: env("ABSENDER", "die Piratenpartei"),
  };
}

function telegramConfig() {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  return {
    token,
    api: env("TELEGRAM_API_URL", "https://api.telegram.org").replace(/\/$/, ""),
    // Telegram-IDs von Personen oder Gruppen (Gruppen-IDs sind negativ)
    erlaubt: liste("TELEGRAM_ERLAUBT").map(String),
  };
}

function matrixConfig() {
  const token = env("MATRIX_TOKEN");
  const nutzer = env("MATRIX_NUTZER");
  if (!token && !nutzer) return null;
  if (!token && !env("MATRIX_PASSWORT")) throw new Error("MATRIX_NUTZER braucht MATRIX_PASSWORT (oder MATRIX_TOKEN eintragen).");
  // Der Server des Bot-Kontos – nicht der Server der Leute: Über die Föderation kann der Bot trotzdem in Räume
  // auf matrix.piratenpartei.de eingeladen werden. Ohne MATRIX_URL ergibt er sich aus MATRIX_NUTZER (@bot:server).
  const url = env("MATRIX_URL", "").replace(/\/$/, "");
  const server = /^@[^:]+:(.+)$/.exec(nutzer ?? "")?.[1];
  if (!url && !server) throw new Error("MATRIX_URL fehlt – die Adresse des Servers, auf dem das Bot-Konto liegt (z. B. https://matrix.org), oder MATRIX_NUTZER als volle ID (@posting-bot:matrix.org).");
  if (url && !/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
    throw new Error("MATRIX_URL muss mit https:// beginnen (nur pantalaimon o. Ä. auf demselben Rechner darf http://localhost sein).");
  }
  const erlaubt = liste("MATRIX_ERLAUBT");
  for (const e of erlaubt.filter((e) => /^\*:(matrix\.org|tchncs\.de|envs\.net|mozilla\.org|kde\.org)$/i.test(e))) {
    console.warn(`⚠️ MATRIX_ERLAUBT enthält ${e} – damit darf jede:r mit Konto auf diesem öffentlichen Server den Bot benutzen. Gemeint ist meist *:piratenpartei.de.`);
  }
  return {
    url,
    server,
    token,
    nutzer,
    passwort: env("MATRIX_PASSWORT"),
    // Matrix-IDs (@name:server), Räume (!raum:server) oder ganze Server (*:piratenpartei.de)
    erlaubt,
    // Einladungen von erlaubten Personen automatisch annehmen
    einladungenAnnehmen: ja("MATRIX_EINLADUNGEN_ANNEHMEN", true),
  };
}

function postizConfig() {
  const url = env("POSTIZ_URL");
  const apiKey = env("POSTIZ_API_KEY");
  if (!url || !apiKey) return null;
  return {
    url: url.replace(/\/$/, ""),
    apiKey,
    kanaele: liste("POSTIZ_KANAELE"),
    kunde: env("POSTIZ_KUNDE", ""),
    // Postiz-Standard API_LIMIT=30 pro Stunde; 0 = nicht mitzählen
    maxAnfragen: Number(env("POSTIZ_MAX_ANFRAGEN", "28")),
    einstellungen: pfad(env("KANAL_EINSTELLUNGEN", "kanaele.json")),
  };
}

function whisperConfig() {
  const modell = env("WHISPER_MODELL");
  if (!modell) return null;
  return {
    bin: env("WHISPER_BIN", "whisper-cli"),
    modell: pfad(modell),
    threads: Number(env("WHISPER_THREADS", "4")),
    sprache: env("WHISPER_SPRACHE", "de"),
  };
}

function webConfig() {
  const port = env("WEB_PORT");
  if (!port) return null;
  const posten = env("WEB_POSTEN", "nein");
  const adresse = env("WEB_ADRESSE", "127.0.0.1");
  const lokal = ["127.0.0.1", "::1", "localhost"].includes(adresse);
  return {
    port: Number(port),
    // Öffentliche Adresse (hinter dem Reverse-Proxy), wird im Bot verlinkt, z. B. https://posting.piraten-xy.de
    url: env("WEB_URL", "").replace(/\/$/, ""),
    adresse,
    // Nur einem Proxy die Absenderadresse glauben, wenn der Bot ausschließlich lokal lauscht
    proxy: ja("WEB_PROXY", lokal),
    // Anmeldung: gemeinsames Passwort und/oder das eigene Matrix-Konto. Mit Postiz Pflicht, ohne Postiz
    // ist die Seite offen (Projekte gehören dann dem Browser), außer es ist trotzdem eine Anmeldung gesetzt.
    passwort: env("WEB_PASSWORT"),
    matrixAnmeldung: ja("WEB_MATRIX_ANMELDUNG", false),
    // Server der Leute, nicht der des Bots: angemeldet wird mit dem eigenen Piraten-Konto
    matrixUrl: env("WEB_MATRIX_URL", "https://matrix.piratenpartei.de").replace(/\/$/, ""),
    // Wer sich mit Matrix anmelden darf: @name:server, *:server
    erlaubt: liste("WEB_ERLAUBT"),
    // Wer posten darf: ja (alle Angemeldeten), nein, oder Liste wie WEB_ERLAUBT
    posten: /^(ja|nein)$/i.test(posten) ? posten.toLowerCase() === "ja" : posten.split(",").map((s) => s.trim()).filter(Boolean),
    // Grenzen gegen Missbrauch
    maxMb: Number(env("WEB_MAX_MB", "500")),
    maxMinuten: Number(env("WEB_MAX_MINUTEN", "20")),
    maxSpeicherGb: Number(env("WEB_MAX_SPEICHER_GB", "20")),
    uploadsProStunde: Number(env("WEB_UPLOADS_PRO_STUNDE", "30")),
    offeneProjekte: Number(env("WEB_OFFENE_PROJEKTE", "15")),
  };
}

export function ladeConfig() {
  const config = {
    telegram: telegramConfig(),
    matrix: matrixConfig(),
    postiz: postizConfig(),
    whisper: whisperConfig(),
    glossar: pfad(env("GLOSSAR", "glossar.txt")),
    // Python mit OpenCV für die Gesichtssuche (pi/install.sh legt es in .venv an); fehlt es, bleibt die Suche aus
    gesicht: { python: pfad(env("GESICHT_PYTHON", ".venv/bin/python")) },
    web: webConfig(),
    ppicng: {
      // Checkout von github.com/Piratenpartei/ppicng (Git-Submodul) – Logos, Schriften, Farben
      dir: pfad(env("PPICNG_DIR", "ppicng")),
      // Adresse der ppicng-Web-App für eigene Sharepics, wird im Bot verlinkt (optional)
      url: env("PPICNG_URL", ""),
    },
    // Voreinstellungen für jeden neuen Beitrag; je Chat überschreibbar in chats.json
    standard: {
      design: env("DESIGN", "weiss-schwarz-orange"),
      logo: env("LOGO", "common/piraten"),
      logoStil: env("LOGO_STIL", "plakette"),
      logoPosition: env("LOGO_POSITION", "oben-links"),
      logoBreite: Number(env("LOGO_BREITE", "0.36")),
      format: env("VIDEO_FORMAT", "original"),
      anpassen: env("VIDEO_ANPASSEN", "rand"),
      sharepicFormat: env("SHAREPIC_FORMAT", "1:1"),
      tonAngleichen: ja("TON_ANGLEICHEN", true),
      hochkant: ja("HOCHKANT_STANDARD", false),
      story: ja("STORY_STANDARD", false),
      tonRauschen: ja("TON_RAUSCHMINDERUNG", false),
      untertitel: ja("UNTERTITEL_STANDARD", true),
      untertitelStil: env("UNTERTITEL_STIL", "box"),
      bauchbinde: env("BAUCHBINDE_NAME") ? { name: env("BAUCHBINDE_NAME"), funktion: env("BAUCHBINDE_FUNKTION", "") } : null,
      bauchbindeAn: ja("BAUCHBINDE_STANDARD", false),
      abspannAn: ja("ABSPANN_STANDARD", false),
      abspannText: env("ABSPANN_TEXT", "piratenpartei.de"),
      absender: env("ABSENDER", "die Piratenpartei"),
      hashtags: env("CAPTION_HASHTAGS", "#Piraten"),
      postizKunde: env("POSTIZ_KUNDE", ""),
    },
    zeiten: {
      titelkarte: Number(env("TITELKARTE_DAUER", "2.5")),
      abspann: Number(env("ABSPANN_DAUER", "3")),
      bauchbindeStart: Number(env("BAUCHBINDE_START", "0.6")),
      bauchbindeDauer: Number(env("BAUCHBINDE_DAUER", "4.5")),
    },
    video: {
      encoder: env("VIDEO_ENCODER", "libx264"),
      preset: env("VIDEO_PRESET", "veryfast"),
      crf: env("VIDEO_CRF", "21"),
    },
    caption: captionConfig(),
    // Querformat-Videos: diese Netzwerke bekommen auf Wunsch die 9:16-Fassung
    hochkant: {
      netze: liste("HOCHKANT_NETZE").length ? liste("HOCHKANT_NETZE") : ["instagram", "instagram-standalone", "tiktok", "tiktok-business"],
    },
    chatsDatei: pfad(env("CHATS", "chats.json")),
    // Fertige Dateien zusätzlich hierhin kopieren, z. B. in einen Nextcloud-Ordner (optional)
    ausgabeOrdner: pfad(env("AUSGABE_ORDNER", "")),
    datenDir: pfad(env("DATEN_DIR", "daten")),
  };
  if (!config.telegram && !config.matrix && !config.web) {
    throw new Error("Weder Telegram noch Matrix noch die Web-Version eingerichtet – TELEGRAM_BOT_TOKEN, MATRIX_TOKEN und/oder WEB_PORT in .env eintragen (Vorlage: .env.example).");
  }
  const w = config.web;
  if (w) {
    w.anmeldung = Boolean(w.passwort || w.matrixAnmeldung);
    if (config.postiz && !w.anmeldung) {
      throw new Error("Mit Postiz braucht die Web-Version eine Anmeldung, sonst könnte jede:r posten: WEB_PASSWORT setzen und/oder WEB_MATRIX_ANMELDUNG=ja mit WEB_ERLAUBT.");
    }
    if (w.passwort && w.passwort.length < 12) throw new Error("WEB_PASSWORT ist zu kurz – mindestens 12 Zeichen (besser eine Passphrase aus mehreren Wörtern).");
    if (w.matrixAnmeldung && !/^https:\/\//.test(w.matrixUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(w.matrixUrl)) {
      throw new Error("WEB_MATRIX_URL muss mit https:// beginnen – sonst gingen Passwörter unverschlüsselt durchs Netz.");
    }
  }
  if (w?.matrixAnmeldung && !w.erlaubt.length) throw new Error("WEB_MATRIX_ANMELDUNG braucht WEB_ERLAUBT, z. B. *:piratenpartei.de");
  return config;
}

/** Voreinstellungen für einen Chat: .env, darüber der Eintrag aus chats.json. */
export function chatStandard(config, chatId) {
  let chats = {};
  try {
    chats = JSON.parse(fs.readFileSync(config.chatsDatei, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`${config.chatsDatei} ist kein gültiges JSON: ${e.message}`);
  }
  const eigene = chats[String(chatId)] ?? {};
  return { ...config.standard, ...eigene };
}
