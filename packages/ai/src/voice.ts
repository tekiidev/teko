import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { getSetting } from './db.js';

/**
 * Voz local no Mac:
 * - ouvir: whisper.cpp (whisper-cli) transcreve o áudio sem mandar nada pra fora
 * - falar: `say` do macOS gera o áudio, que o app toca (e usa pra animar a aura)
 */

const run = promisify(execFile);

export const MODELS_DIR = path.join(DATA_DIR, 'models');
// Voz clonada: gravação de referência e ambiente Python ficam em data/ (fora do git).
export const VOICE_DIR = path.join(DATA_DIR, 'voice');
export const REFERENCE_WAV = path.join(VOICE_DIR, 'referencia.wav');
export const VOICE_ENV_PYTHON = path.join(DATA_DIR, 'voice-env', 'bin', 'python');
export const DEFAULT_MODEL = 'ggml-small.bin';
// Modelo menor e mais rápido só pra conferir a palavra de ativação.
export const WAKE_MODEL = 'ggml-base.bin';
export const modelUrl = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`;
export const MODEL_URL = modelUrl(DEFAULT_MODEL);
const MAX_SPEAK_CHARS = 1500;
const VOCAB = 'Teko, Teki, Cofu, Heka, tekidev, Claude, Gemini.';

export function voiceSettings() {
  const cfg = getSetting('voice', {}) || {};
  return {
    whisperBin: process.env.WHISPER_BIN || cfg.whisperBin || 'whisper-cli',
    model: process.env.WHISPER_MODEL || cfg.model || path.join(MODELS_DIR, DEFAULT_MODEL),
    wakeModel: process.env.WHISPER_WAKE_MODEL || cfg.wakeModel || path.join(MODELS_DIR, WAKE_MODEL),
    language: cfg.language || 'pt',
    // say do macOS: reserva quando a voz clonada não está no ar (masculina).
    voice: process.env.TEKO_VOICE || cfg.voice || 'Reed',
    // auto = voz clonada se o servidor dela estiver rodando, senão say.
    engine: process.env.TEKO_VOICE_ENGINE || cfg.engine || 'auto',
    ttsUrl: process.env.TEKO_TTS_URL || cfg.ttsUrl || 'http://127.0.0.1:4781',
    rate: Number(cfg.rate) > 0 ? Number(cfg.rate) : 190,
  };
}

async function has(bin) {
  try {
    await run('/usr/bin/which', [bin]);
    return true;
  } catch {
    return false;
  }
}

export async function voiceStatus() {
  const s = voiceSettings();
  return {
    platform: process.platform,
    whisper: await has(s.whisperBin),
    model: fs.existsSync(s.model),
    modelPath: s.model,
    wakeModel: fs.existsSync(s.wakeModel),
    say: process.platform === 'darwin' && (await has('say')),
    voice: s.voice,
    clone: await cloneOnline(s.ttsUrl),
    reference: fs.existsSync(REFERENCE_WAV),
  };
}

function tempFile(ext) {
  return path.join(os.tmpdir(), `teko-${crypto.randomUUID()}.${ext}`);
}

/** Transcreve um WAV (16 kHz mono) com o whisper.cpp local. */
export async function transcribe(wav: Buffer, { wake = false } = {}) {
  const s = voiceSettings();
  // Na ativação usa o modelo rápido; se ele não existir, cai no normal.
  const model = wake && fs.existsSync(s.wakeModel) ? s.wakeModel : s.model;
  if (!fs.existsSync(model)) throw new Error('modelo do whisper não encontrado: rode npm run voice:setup');
  const file = tempFile('wav');
  fs.writeFileSync(file, wav, { mode: 0o600 });
  try {
    // O prompt dá vocabulário ao whisper: sem ele, "Teko" vira "Teco".
    const args = ['-m', model, '-l', s.language, '-nt', '-np', '--prompt', VOCAB, '-f', file];
    const { stdout } = await run(s.whisperBin, args, {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return cleanTranscript(stdout);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Como o whisper costuma escrever "Teko" quando ouve (teko, teku, tico, tireku...):
// T + vogal "e/i" opcional + som de K + vogal final. "teto", "taco" e "tchau" não passam.
const WAKE_RE = /^t(?:e|i|ie|ir|ire|er|ee|eh)?(?:k|c|ck|kk|qu)(?:o|u|e)$/;
const LEAD_INS = new Set(['ei', 'hey', 'ey', 'oi', 'o', 'e', 'ai', 'alo']);

const plain = (w: string) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

/**
 * Confere se a frase começa chamando o Teko ("Teko", "Ei, Teko", "Oi Teko, ...").
 * Só vale como primeira palavra (ou depois de um "ei"/"oi"), pra não disparar no meio de conversa.
 * Devolve o resto da frase, que pode já ser a pergunta.
 */
export function detectWake(text: string) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && !plain(words[i])) i += 1; // pula pontuação solta
  if (words[i] && LEAD_INS.has(plain(words[i]))) i += 1;
  if (!words[i] || !WAKE_RE.test(plain(words[i]))) return { wake: false, rest: '' };
  const rest = words.slice(i + 1).join(' ').replace(/^[,.!?:;\s]+/, '').trim();
  return { wake: true, rest };
}

/** Tira marcações que o whisper põe quando não ouve fala ([BLANK_AUDIO], (música) etc.). */
export function cleanTranscript(text: string) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deixa o texto bom pra ouvir: sem markdown, sem blocos de código, sem links crus. */
export function speakable(text: string) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (tem um código na tela) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'um link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

async function cloneOnline(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Voz clonada (servidor local do Chatterbox). Devolve null se não estiver no ar ou falhar. */
async function speakClone(text: string, url: string) {
  try {
    const res = await fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Gera a fala (voz clonada se estiver no ar, senão `say` do macOS) e devolve um WAV. */
export async function speak(text: string) {
  const s = voiceSettings();
  const clean = speakable(text);
  if (!clean) throw new Error('nada pra falar');
  if (s.engine !== 'say') {
    const wav = await speakClone(clean, s.ttsUrl);
    if (wav) return wav;
    if (s.engine === 'clone') throw new Error('voz clonada fora do ar: rode npm run voz:clone');
  }
  if (process.platform !== 'darwin') throw new Error('voz disponível só no macOS por enquanto');
  const input = tempFile('txt');
  const out = tempFile('wav');
  fs.writeFileSync(input, clean, { mode: 0o600 });
  try {
    await run('say', ['-v', s.voice, '-r', String(s.rate), '-f', input, '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050'], {
      timeout: 60_000,
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(out, { force: true });
  }
}
