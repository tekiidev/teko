import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(desktopDir, '../..');
const visionPackage = path.join(repoDir, 'node_modules/@mediapipe/tasks-vision');
const wasmSource = path.join(visionPackage, 'wasm');
const modelSource = path.join(repoDir, 'data/models/hand_landmarker.task');
const vendorTarget = path.join(desktopDir, 'web/vendor/mediapipe');
const wasmTarget = path.join(vendorTarget, 'wasm');
const modelTargetDir = path.join(desktopDir, 'web/models');

const wasmFiles = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
];

if (!fs.existsSync(path.join(visionPackage, 'vision_bundle.mjs'))) {
  throw new Error('MediaPipe não instalado. Rode npm install na raiz do Teko.');
}
if (!fs.existsSync(modelSource) || fs.statSync(modelSource).size < 1_000_000) {
  throw new Error('Modelo de mãos ausente. Rode npm run vision:setup na raiz do Teko.');
}
for (const name of wasmFiles) {
  if (!fs.existsSync(path.join(wasmSource, name))) {
    throw new Error(`Runtime MediaPipe incompleto: ${name} não encontrado.`);
  }
}

fs.mkdirSync(wasmTarget, { recursive: true });
fs.mkdirSync(modelTargetDir, { recursive: true });
fs.copyFileSync(path.join(visionPackage, 'vision_bundle.mjs'), path.join(vendorTarget, 'vision_bundle.mjs'));
for (const name of wasmFiles) fs.copyFileSync(path.join(wasmSource, name), path.join(wasmTarget, name));
fs.copyFileSync(modelSource, path.join(modelTargetDir, 'hand_landmarker.task'));
console.log('Detector local preparado para o Teko nativo.');
