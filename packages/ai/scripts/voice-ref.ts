// Prepara a gravação de referência da voz clonada.
// Uso: npm run voz:referencia -- ~/Downloads/minha-voz.m4a
// Sem arquivo: mostra o texto sugerido pra ler.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REFERENCE_WAV, VOICE_DIR } from '../src/voice.js';

const TEXTO = `
Grave uns 30 segundos com o Gravador do Mac (ou o celular), num lugar silencioso,
falando natural, do seu jeito, com o seu sotaque. Pode ler isto:

  "Oxe, rapaz, bora lá. Eu sou o Teko, o assistente do Teki, feito aqui em São Luís.
   Hoje a gente vai resolver esse bug, depois tomar um guaraná Jesus e comer um arroz de cuxá.
   Se der certo, beleza; se não der, a gente tenta de novo, sem estresse.
   Me diz aí: o que tu quer fazer agora?"

Depois rode:  npm run voz:referencia -- caminho/da/gravacao.m4a
`;

const entrada = process.argv[2];
if (!entrada) {
  console.log(TEXTO);
  process.exit(0);
}
if (!fs.existsSync(entrada)) {
  console.error(`arquivo não encontrado: ${entrada}`);
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('a conversão usa o afconvert do macOS; em outro sistema, salve direto um WAV 24 kHz mono em ' + REFERENCE_WAV);
  process.exit(1);
}

fs.mkdirSync(VOICE_DIR, { recursive: true, mode: 0o700 });
// WAV 24 kHz mono 16 bits: o formato que o modelo usa.
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', path.resolve(entrada), REFERENCE_WAV]);
fs.chmodSync(REFERENCE_WAV, 0o600);

const bytes = fs.statSync(REFERENCE_WAV).size - 44;
const segundos = bytes / (24000 * 2);
console.log(`ok: ${REFERENCE_WAV} (${segundos.toFixed(1)} s)`);
if (segundos < 8) console.log('aviso: curta demais; o ideal é de 15 a 40 segundos.');
if (segundos > 60) console.log('aviso: longa; o modelo usa só o começo. 15 a 40 segundos bastam.');
console.log('A gravação fica só em data/voice (fora do git). Agora: npm run voz:clone');
