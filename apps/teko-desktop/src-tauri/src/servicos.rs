// Servidor do Teko e voz clonada subindo junto com o app.
// Quando o Mac abre o Teko sozinho (login), ninguém rodou `npm start` nem `npm run voz:clone`.
// Ao abrir, o app confere as portas; o que não estiver no ar ele sobe, com log em data/logs.
// Ao sair, encerra só o que ele mesmo abriu (se você rodou `npm start` na mão, fica rodando).

use std::fs::OpenOptions;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// Processos que este app abriu.
#[derive(Default)]
pub struct Servicos(pub Mutex<Vec<Child>>);

/// Raiz do repositório (apps/teko-desktop/src-tauri -> ../../..), fixada na compilação.
fn raiz() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    dir.canonicalize().unwrap_or(dir)
}

/// Node encontrado na compilação (o Mac abre apps com PATH mínimo, sem o nvm).
fn node() -> String {
    option_env!("TEKO_NODE").unwrap_or("node").to_string()
}

fn no_ar(porta: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], porta));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// PATH com Homebrew (whisper-cli, ffmpeg) e a pasta do Node, pra o que o servidor chama.
fn path_completo() -> String {
    let pasta_node = Path::new(&node()).parent().map(|p| p.display().to_string()).unwrap_or_default();
    let atual = std::env::var("PATH").unwrap_or_default();
    format!("{pasta_node}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{atual}")
}

fn log(nome: &str) -> Stdio {
    let pasta = raiz().join("data/logs");
    let _ = std::fs::create_dir_all(&pasta);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(pasta.join(nome))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn subir(nome: &str, mut cmd: Command, servicos: &Servicos) {
    cmd.env("PATH", path_completo()).stdout(log(nome)).stderr(log(nome)).stdin(Stdio::null());
    // Grupo de processos próprio: o tsx abre um Node filho, e encerrar o grupo leva os dois.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    match cmd.spawn() {
        Ok(filho) => servicos.0.lock().unwrap().push(filho),
        Err(err) => eprintln!("[Teko] não consegui subir {nome}: {err}"),
    }
}

/// Sobe o servidor (4780) e a voz clonada (4781) se ainda não estiverem no ar.
pub fn iniciar(servicos: &Servicos) {
    let raiz = raiz();
    if !no_ar(4780) {
        let tsx = raiz.join("node_modules/tsx/dist/cli.mjs");
        if tsx.exists() {
            let mut cmd = Command::new(node());
            cmd.arg(tsx).arg("src/server.ts").current_dir(raiz.join("apps/teko"));
            subir("teko.log", cmd, servicos);
        } else {
            eprintln!("[Teko] servidor não instalado (falta node_modules): rode npm install");
        }
    }
    // Voz clonada só se o ambiente e a gravação de referência existirem.
    let python = raiz.join("data/voice-mlx/bin/python");
    let referencia = raiz.join("data/voice/referencia.wav");
    let servidor_voz = raiz.join("packages/ai/voice/tts_server.py");
    if !no_ar(4781) && python.exists() && referencia.exists() && servidor_voz.exists() {
        let mut cmd = Command::new(python);
        cmd.arg(servidor_voz).arg(referencia).arg("4781").current_dir(&raiz);
        subir("voz.log", cmd, servicos);
    }
}

/// Encerra o que este app abriu.
pub fn encerrar(servicos: &Servicos) {
    for mut filho in servicos.0.lock().unwrap().drain(..) {
        // SIGTERM pro grupo inteiro (pid negativo = grupo); deixa o servidor fechar o banco direito.
        #[cfg(unix)]
        let _ = Command::new("/bin/kill").arg("-TERM").arg(format!("-{}", filho.id())).status();
        #[cfg(not(unix))]
        let _ = filho.kill();
        let _ = filho.wait();
    }
}
