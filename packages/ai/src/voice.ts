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
export const DEFAULT_MODEL = 'ggml-small.bin';
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;
const MAX_SPEAK_CHARS = 1500;
const VOCAB = 'Teko, Teki, Cofu, Heka, tekidev, Claude, Gemini.';

export function voiceSettings() {
  const cfg = getSetting('voice', {}) || {};
  return {
    whisperBin: process.env.WHISPER_BIN || cfg.whisperBin || 'whisper-cli',
    model: process.env.WHISPER_MODEL || cfg.model || path.join(MODELS_DIR, DEFAULT_MODEL),
    language: cfg.language || 'pt',
    voice: process.env.TEKO_VOICE || cfg.voice || 'Luciana',
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
    say: process.platform === 'darwin' && (await has('say')),
    voice: s.voice,
  };
}

function tempFile(ext) {
  return path.join(os.tmpdir(), `teko-${crypto.randomUUID()}.${ext}`);
}

/** Transcreve um WAV (16 kHz mono) com o whisper.cpp local. */
export async function transcribe(wav: Buffer) {
  const s = voiceSettings();
  if (!fs.existsSync(s.model)) throw new Error('modelo do whisper não encontrado: rode npm run voice:setup');
  const file = tempFile('wav');
  fs.writeFileSync(file, wav, { mode: 0o600 });
  try {
    // O prompt dá vocabulário ao whisper: sem ele, "Teko" vira "Teco".
    const args = ['-m', s.model, '-l', s.language, '-nt', '-np', '--prompt', VOCAB, '-f', file];
    const { stdout } = await run(s.whisperBin, args, {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return cleanTranscript(stdout);
  } finally {
    fs.rmSync(file, { force: true });
  }
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

/** Gera a fala com o `say` do macOS e devolve um WAV. */
export async function speak(text: string) {
  if (process.platform !== 'darwin') throw new Error('voz disponível só no macOS por enquanto');
  const s = voiceSettings();
  const clean = speakable(text);
  if (!clean) throw new Error('nada pra falar');
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
