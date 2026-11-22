"""Servidor local de voz clonada do Teko.

Chatterbox multilíngue (licença MIT) rodando em MLX, nativo do chip da Apple:
no MacBook M5 cada frase sai em poucos segundos (no PyTorch levava de 15 a 60 s).
Fala com a voz da gravação de referência e escuta só em 127.0.0.1.

Uso: data/voice-mlx/bin/python packages/ai/voice/tts_server.py <referencia.wav> [porta]
"""

import io
import json
import os
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

REFERENCIA = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else ""
PORTA = int(sys.argv[2]) if len(sys.argv) > 2 else 4781
MODELO = os.environ.get("TEKO_TTS_MODEL", "mlx-community/chatterbox-multilingual-v3")
MAX_CHARS = 600

if not REFERENCIA or not os.path.exists(REFERENCIA):
    sys.exit(f"gravação de referência não encontrada: {REFERENCIA or '(vazio)'}")


def _num(nome, padrao, minimo, maximo):
    try:
        return min(maximo, max(minimo, float(os.environ.get(nome, padrao))))
    except ValueError:
        return padrao


# Padrões = os da amostra escolhida pelo Teki ("voz A"). Dá pra ajustar por variável de ambiente.
EXAGGERATION = _num("TEKO_TTS_EXAGGERATION", 0.1, 0.0, 1.0)
AJUSTES = {
    "cfg_weight": _num("TEKO_TTS_CFG", 0.5, 0.0, 1.0),
    "temperature": _num("TEKO_TTS_TEMPERATURE", 0.8, 0.3, 1.2),
}

print(f"[voz] carregando {MODELO} (na primeira vez baixa o modelo)...", flush=True)
from mlx_audio.tts.utils import load_model  # noqa: E402
from mlx_audio.utils import load_audio  # noqa: E402

modelo = load_model(MODELO)
SR = modelo.sample_rate

# A gravação de referência é processada uma vez só, aqui na subida.
conds = modelo.prepare_conditionals(load_audio(REFERENCIA, sample_rate=SR), SR, EXAGGERATION)
trava = threading.Lock()  # um áudio por vez


def gerar(texto: str) -> bytes:
    texto = re.sub(r"\s+", " ", texto).strip()[:MAX_CHARS]
    # Limite de tokens de áudio pelo tamanho do texto, pra não gerar além do necessário.
    limite = min(1000, int(len(texto) * 2.6) + 60)
    with trava:
        partes = [
            np.array(r.audio)
            for r in modelo.generate(
                texto, conds=conds, lang_code="pt", max_new_tokens=limite, verbose=False, **AJUSTES
            )
        ]
    audio = np.concatenate(partes) if partes else np.zeros(1, dtype=np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return buf.getvalue()


# Aquece, pra primeira resposta não demorar a mais.
gerar("Oi.")
print(f"[voz] pronto em http://127.0.0.1:{PORTA}", flush=True)


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
            return self.responder(200, json.dumps({"ok": True, "engine": "mlx", "model": MODELO}).encode())
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
