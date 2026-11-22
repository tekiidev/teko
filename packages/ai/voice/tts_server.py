"""Servidor local de voz clonada do Teko (Chatterbox, licença MIT).

Carrega o modelo uma vez e fala com a voz da gravação de referência.
Escuta só em 127.0.0.1 (nada de fora do Mac acessa).

Uso: data/voice-env/bin/python packages/ai/voice/tts_server.py <referencia.wav> [porta]
"""

import io
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
import torchaudio as ta

REFERENCIA = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else ""
PORTA = int(sys.argv[2]) if len(sys.argv) > 2 else 4781
MAX_CHARS = 600

if not REFERENCIA or not os.path.exists(REFERENCIA):
    sys.exit(f"gravação de referência não encontrada: {REFERENCIA or '(vazio)'}")

device = os.environ.get("TEKO_TTS_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
print(f"[voz] carregando modelo em {device}...", flush=True)


from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

# Passar o nome ("mps"/"cpu"), não torch.device: é assim que ele decide carregar os pesos
# (salvos numa GPU NVIDIA) primeiro na CPU.
modelo = ChatterboxMultilingualTTS.from_pretrained(device=device)
trava = threading.Lock()  # um áudio por vez (o modelo não é thread-safe)

# Aquece o modelo com a referência, pra primeira resposta não demorar a mais.
with trava:
    modelo.generate("Oi.", language_id="pt", audio_prompt_path=REFERENCIA)
print(f"[voz] pronto em http://127.0.0.1:{PORTA}", flush=True)


def _num(nome, padrao, minimo, maximo):
    try:
        return min(maximo, max(minimo, float(os.environ.get(nome, padrao))))
    except ValueError:
        return padrao


# Ajustes de semelhança (env ou padrão escolhido no teste com a referência do Teki):
# - exaggeration: expressividade (0.25 a 1)
# - cfg_weight: mais baixo = segue mais o ritmo e o jeito da referência
# - temperature: mais baixo = mais estável e parecido, menos variação
AJUSTES = {
    "exaggeration": _num("TEKO_TTS_EXAGGERATION", 0.5, 0.25, 1.0),
    "cfg_weight": _num("TEKO_TTS_CFG", 0.3, 0.0, 1.0),
    "temperature": _num("TEKO_TTS_TEMPERATURE", 0.7, 0.3, 1.2),
}


def gerar(texto: str) -> bytes:
    texto = re.sub(r"\s+", " ", texto).strip()[:MAX_CHARS]
    with trava:
        wav = modelo.generate(texto, language_id="pt", audio_prompt_path=REFERENCIA, **AJUSTES)
    buf = io.BytesIO()
    ta.save(buf, wav.cpu(), modelo.sr, format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silencioso
        pass

    def responder(self, status, corpo, tipo="application/json"):
        self.send_response(status)
        self.send_header("content-type", tipo)
        self.send_header("content-length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        if self.path == "/health":
            return self.responder(200, json.dumps({"ok": True, "device": device}).encode())
        self.responder(404, b'{"error":"nao encontrado"}')

    def do_POST(self):
        if self.path != "/tts":
            return self.responder(404, b'{"error":"nao encontrado"}')
        try:
            tamanho = int(self.headers.get("content-length") or 0)
            if tamanho > 64_000:
                return self.responder(413, b'{"error":"texto grande demais"}')
            texto = json.loads(self.rfile.read(tamanho) or b"{}").get("text", "")
            if not texto.strip():
                return self.responder(400, b'{"error":"texto vazio"}')
            self.responder(200, gerar(texto), "audio/wav")
        except Exception as erro:  # noqa: BLE001
            print(f"[voz] erro: {erro}", flush=True)
            self.responder(500, json.dumps({"error": str(erro)}).encode())


ThreadingHTTPServer(("127.0.0.1", PORTA), Handler).serve_forever()
