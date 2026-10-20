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
  return {
    url: env("MATRIX_URL", "https://matrix.piratenpartei.de").replace(/\/$/, ""),
    token,
    nutzer,
    passwort: env("MATRIX_PASSWORT"),
    // Matrix-IDs (@name:server), Räume (!raum:server) oder ganze Server (*:piratenpartei.de)
    erlaubt: liste("MATRIX_ERLAUBT"),
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

export function ladeConfig() {
  const config = {
    telegram: telegramConfig(),
    matrix: matrixConfig(),
    postiz: postizConfig(),
    whisper: whisperConfig(),
    glossar: pfad(env("GLOSSAR", "glossar.txt")),
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
    chatsDatei: pfad(env("CHATS", "chats.json")),
    // Fertige Dateien zusätzlich hierhin kopieren, z. B. in einen Nextcloud-Ordner (optional)
    ausgabeOrdner: pfad(env("AUSGABE_ORDNER", "")),
    datenDir: pfad(env("DATEN_DIR", "daten")),
  };
  if (!config.telegram && !config.matrix) {
    throw new Error("Weder Telegram noch Matrix eingerichtet – TELEGRAM_BOT_TOKEN und/oder MATRIX_TOKEN in .env eintragen (Vorlage: .env.example).");
  }
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
