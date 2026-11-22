// Baixa o modelo do whisper.cpp (uma vez) e confere se a voz do Mac está pronta.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, MODEL_URL, WAKE_MODEL, modelUrl, voiceSettings, voiceStatus } from '../src/voice.js';

const s = voiceSettings();
fs.mkdirSync(MODELS_DIR, { recursive: true });

async function baixar(destino: string, url: string, tamanho: string) {
  if (fs.existsSync(destino)) {
    console.log(`já existe: ${destino}`);
    return;
  }
  console.log(`baixando ${url}\n(${tamanho}, só na primeira vez)`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`falha ao baixar: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let last = 0;
  const tmp = `${destino}.part`;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct >= last + 10) {
        last = pct;
        process.stdout.write(`  ${pct}%\n`);
      }
      ctrl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, destino);
  console.log(`ok: ${destino}`);
}

// Modelo principal (transcrever o que você pede) e o rápido (conferir o "Teko").
await baixar(s.model, MODEL_URL, 'uns 470 MB');
await baixar(s.wakeModel, modelUrl(WAKE_MODEL), 'uns 145 MB');

const st = await voiceStatus();
console.log(`\nwhisper-cli: ${st.whisper ? 'ok' : 'falta (brew install whisper-cpp)'}`);
console.log(`modelo:      ${st.model ? 'ok' : 'falta'}`);
console.log(`ativação:    ${st.wakeModel ? 'ok' : 'falta'}`);
console.log(`voz (say):   ${st.say ? `ok, ${st.voice}` : 'só no macOS'}`);
