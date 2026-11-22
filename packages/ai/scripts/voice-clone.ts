// Sobe o servidor local da voz clonada (Chatterbox) usando o ambiente Python em data/voice-env.
// Uso: npm run voz:clone   (deixe rodando junto com o npm start)
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REFERENCE_WAV, VOICE_ENV_PYTHON } from '../src/voice.js';

const SERVIDOR = fileURLToPath(new URL('../voice/tts_server.py', import.meta.url));

if (!fs.existsSync(VOICE_ENV_PYTHON)) {
  console.error(`Ambiente Python da voz não encontrado. Instale uma vez:
  python3.11 -m venv data/voice-env
  data/voice-env/bin/pip install chatterbox-tts "setuptools<81"`);
  process.exit(1);
}
if (!fs.existsSync(REFERENCE_WAV)) {
  console.error('Falta a gravação de referência. Rode: npm run voz:referencia');
  process.exit(1);
}

const filho = spawn(VOICE_ENV_PYTHON, [SERVIDOR, REFERENCE_WAV, process.env.TEKO_TTS_PORT || '4781'], {
  stdio: 'inherit',
  // MPS (GPU do Mac): usa a CPU no que a GPU ainda não suporta, em vez de quebrar.
  env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' },
});
filho.on('exit', (code) => process.exit(code ?? 0));
for (const sinal of ['SIGINT', 'SIGTERM'] as const) process.on(sinal, () => filho.kill(sinal));
