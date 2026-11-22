import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@teko/ai/config';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const modelDir = path.join(DATA_DIR, 'models');
const modelPath = path.join(modelDir, 'hand_landmarker.task');

fs.mkdirSync(modelDir, { recursive: true });
if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1_000_000) {
  console.log(`Modelo de gestos já instalado: ${modelPath}`);
  process.exit(0);
}

const temporaryPath = `${modelPath}.download`;
console.log('Baixando o modelo local de gestos (aprox. 7,5 MB)…');
const response = await fetch(MODEL_URL);
if (!response.ok || !response.body) throw new Error(`Download do modelo falhou: HTTP ${response.status}`);
await fs.promises.writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
if (fs.statSync(temporaryPath).size < 1_000_000) {
  fs.rmSync(temporaryPath, { force: true });
  throw new Error('O arquivo baixado parece incompleto. Rode npm run vision:setup novamente.');
}
fs.renameSync(temporaryPath, modelPath);
console.log(`Modelo pronto: ${modelPath}`);
