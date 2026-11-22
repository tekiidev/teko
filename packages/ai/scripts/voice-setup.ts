// Baixa o modelo do whisper.cpp (uma vez) e confere se a voz do Mac está pronta.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, MODEL_URL, voiceSettings, voiceStatus } from '../src/voice.js';

const s = voiceSettings();
fs.mkdirSync(MODELS_DIR, { recursive: true });

if (fs.existsSync(s.model)) {
  console.log(`modelo já existe: ${s.model}`);
} else {
  console.log(`baixando ${MODEL_URL}\n(uns 470 MB, só na primeira vez)`);
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`falha ao baixar: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let last = 0;
  const tmp = `${s.model}.part`;
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
  fs.renameSync(tmp, s.model);
  console.log(`ok: ${s.model}`);
}

const st = await voiceStatus();
console.log(`\nwhisper-cli: ${st.whisper ? 'ok' : 'falta (brew install whisper-cpp)'}`);
console.log(`modelo:      ${st.model ? 'ok' : 'falta'}`);
console.log(`voz (say):   ${st.say ? `ok, ${st.voice}` : 'só no macOS'}`);
