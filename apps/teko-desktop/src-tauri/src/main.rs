// Teko no Mac: app de barra de menu com uma aura transparente por cima de tudo.
// O Rust só cuida do que o navegador não alcança: atalho global, janela e ícone na barra.
// Microfone, aura e conversa com o servidor do Teko ficam no web/ (HTML + JS).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ilha;
mod servicos;

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

/// Se o reconhecimento de gestos está ligado no menu; o mapa recebe isso na URL.
struct GestoAtivo(Arc<AtomicBool>);

/// Microfone ligado ou desligado, e o item do menu (sincronizado com a ilha e a voz).
struct MicLigado {
    ligado: AtomicBool,
    item: std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

/// Liga ou desliga o microfone (sem `ligado`, alterna). Desligado, nada abre o microfone.
#[tauri::command]
fn definir_microfone(app: tauri::AppHandle, estado: tauri::State<'_, MicLigado>, ligado: Option<bool>) -> bool {
    let novo = ligado.unwrap_or(!estado.ligado.load(Ordering::Relaxed));
    estado.ligado.store(novo, Ordering::Relaxed);
    if let Some(item) = estado.item.lock().unwrap().as_ref() {
        let _ = item.set_checked(novo);
    }
    let _ = app.emit("microfone", novo);
    novo
}

/// Item "Reconhecer gesto T" do menu, pra acompanhar quando a voz liga ou desliga os gestos.
struct ItemGestos(std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// "Teko, ativar/desativar gestos": mesmo efeito do item do menu.
#[tauri::command]
fn definir_gestos(app: tauri::AppHandle, ativo: bool) {
    app.state::<GestoAtivo>().0.store(ativo, Ordering::Relaxed);
    if let Some(item) = app.state::<ItemGestos>().0.lock().unwrap().as_ref() {
        let _ = item.set_checked(ativo);
    }
    let _ = app.emit("gestos", ativo);
}

/// "Teko, autodestruir": fecha o app (e o servidor e a voz que ele abriu, no RunEvent::Exit).
#[tauri::command]
fn sair_teko(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn voice_local_request(action: String, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let (path, content_type) = match action.as_str() {
        "wake" => ("/api/voice/wake", "audio/wav"),
        "transcribe" => ("/api/voice/transcribe", "audio/wav"),
        "chat" => ("/api/chat", "application/json"),
        "speak" => ("/api/voice/speak", "application/json"),
        _ => return Err("ação de voz desconhecida".into()),
    };

    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:4780{path}"))
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .timeout(std::time::Duration::from_secs(200))
        .body(body)
        .send()
        .await
        .map_err(|err| format!("não consegui conectar ao Teko em 127.0.0.1:4780: {err}"))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|err| format!("resposta do Teko incompleta: {err}"))?;
    if !status.is_success() {
        return Err(format!("Teko respondeu HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    Ok(bytes.to_vec())
}

/// Chat em streaming: repassa cada evento SSE do Teko pro app assim que chega.
/// Assim o app vê pedidos de aprovação no meio da resposta e pode perguntar "posso?".
#[tauri::command]
async fn chat_stream(body: Vec<u8>, on_event: tauri::ipc::Channel<String>) -> Result<(), String> {
    let mut response = reqwest::Client::new()
        .post("http://127.0.0.1:4780/api/chat")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(std::time::Duration::from_secs(30 * 60))
        .body(body)
        .send()
        .await
        .map_err(|err| format!("não consegui conectar ao Teko em 127.0.0.1:4780: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let texto = response.text().await.unwrap_or_default();
        return Err(format!("Teko respondeu HTTP {status}: {texto}"));
    }
    let mut buffer = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| format!("resposta do Teko incompleta: {err}"))? {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(fim) = buffer.find("\n\n") {
            let evento: String = buffer.drain(..fim + 2).collect();
            for linha in evento.lines() {
                if let Some(dado) = linha.strip_prefix("data:") {
                    let _ = on_event.send(dado.trim().to_string());
                }
            }
        }
    }
    Ok(())
}

/// Aprova ou nega uma ferramenta pendente (o Teko espera essa resposta pra seguir).
#[tauri::command]
async fn approve_tool(id: String, approved: bool) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("id de aprovação inválido".into());
    }
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:4780/api/approvals/{id}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .body(format!("{{\"approved\":{approved}}}"))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Teko respondeu HTTP {}", response.status()));
    }
    Ok(())
}

#[tauri::command]
fn open_context_map(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("mapa-aberto", ());
    if let Some(aura) = app.get_webview_window("aura") {
        let _ = aura.hide();
    }

    if let Some(window) = app.get_webview_window("context-map") {
        window.set_fullscreen(true).map_err(|err| err.to_string())?;
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }

    // Com gestos ligados, o próprio mapa assume a câmera: juntar as mãos fecha o mapa.
    let gestos = app.state::<GestoAtivo>().0.load(Ordering::Relaxed);
    let url = tauri::Url::parse(&format!("http://127.0.0.1:4780/?native=1&gestos={}#map", u8::from(gestos)))
        .map_err(|err| err.to_string())?;
    WebviewWindowBuilder::new(&app, "context-map", WebviewUrl::External(url))
        .title("Teko · Mapa neural")
        .fullscreen(true)
        .build()
        .map_err(|err| {
            if let Some(aura) = app.get_webview_window("aura") { let _ = aura.show(); }
            err.to_string()
        })?
        .set_focus()
        .map_err(|err| err.to_string())
}

/// Esc cancela a conversa. Só fica registrado enquanto há conversa: um atalho global
/// com Esc roubaria a tecla de todos os outros apps.
#[tauri::command]
fn definir_esc(app: tauri::AppHandle, ativo: bool) -> Result<(), String> {
    let esc = Shortcut::new(None, Code::Escape);
    let atalhos = app.global_shortcut();
    let registrado = atalhos.is_registered(esc);
    if ativo && !registrado {
        atalhos.register(esc).map_err(|err| err.to_string())?;
    } else if !ativo && registrado {
        atalhos.unregister(esc).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Tamanho padrão da aura (o mesmo do tauri.conf.json).
const AURA_LARGURA: f64 = 460.0;
const AURA_ALTURA: f64 = 520.0;

#[derive(serde::Serialize)]
struct GeometriaAura {
    x: f64,
    y: f64,
    largura: f64,
    altura: f64,
    tela_x: f64,
    tela_y: f64,
    tela_largura: f64,
    tela_altura: f64,
}

/// Onde a aura está e o tamanho da tela dela (em pontos), pra mover com gesto.
#[tauri::command]
fn aura_geometria(window: tauri::WebviewWindow) -> Result<GeometriaAura, String> {
    let escala = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(escala);
    let tam = window.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(escala);
    let tela = window.current_monitor().map_err(|e| e.to_string())?.ok_or("sem tela")?;
    let tela_pos = tela.position().to_logical::<f64>(escala);
    let tela_tam = tela.size().to_logical::<f64>(escala);
    Ok(GeometriaAura {
        x: pos.x, y: pos.y, largura: tam.width, altura: tam.height,
        tela_x: tela_pos.x, tela_y: tela_pos.y, tela_largura: tela_tam.width, tela_altura: tela_tam.height,
    })
}

/// Move e redimensiona a aura, sem deixar ela sair da tela nem ficar minúscula ou gigante.
#[tauri::command]
fn posicionar_aura(window: tauri::WebviewWindow, x: f64, y: f64, largura: f64, altura: f64) -> Result<(), String> {
    let escala = window.scale_factor().map_err(|e| e.to_string())?;
    let tela = window.current_monitor().map_err(|e| e.to_string())?.ok_or("sem tela")?;
    let tp = tela.position().to_logical::<f64>(escala);
    let tt = tela.size().to_logical::<f64>(escala);
    let w = largura.clamp(AURA_LARGURA * 0.5, AURA_LARGURA * 1.8).min(tt.width);
    let h = altura.clamp(AURA_ALTURA * 0.5, AURA_ALTURA * 1.8).min(tt.height);
    // O limite é sempre a tela: a janela da aura nunca passa da borda.
    let x = x.clamp(tp.x, tp.x + tt.width - w);
    let y = y.clamp(tp.y, tp.y + tt.height - h);
    window.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())
}

/// Volta a aura pro meio da tela, no tamanho padrão.
fn centralizar_aura(app: &tauri::AppHandle) {
    if let Some(aura) = app.get_webview_window("aura") {
        colocar_no_centro(&aura);
        let _ = app.emit_to("aura", "aura-centralizada", ());
    }
}

/// O desenho da aura fica a 44% da altura da janela (a legenda fica embaixo), então
/// centralizar a janela deixava a aura alta. Aqui o centro do desenho vai pro centro da tela.
fn colocar_no_centro(aura: &tauri::WebviewWindow) {
    let _ = aura.set_size(tauri::LogicalSize::new(AURA_LARGURA, AURA_ALTURA));
    let (Ok(escala), Ok(Some(tela))) = (aura.scale_factor(), aura.current_monitor()) else { return };
    let tp = tela.position().to_logical::<f64>(escala);
    let tt = tela.size().to_logical::<f64>(escala);
    let x = tp.x + (tt.width - AURA_LARGURA) / 2.0;
    let y = (tp.y + tt.height / 2.0 - AURA_ALTURA * 0.44).clamp(tp.y, tp.y + tt.height - AURA_ALTURA);
    let _ = aura.set_position(tauri::LogicalPosition::new(x, y));
}

/// Aura visível ou escondida, e o item do menu que mostra isso (fica sincronizado
/// quando quem troca é a ilha).
struct AuraVisivel {
    ligada: AtomicBool,
    item: std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

/// Mostra ou esconde a aura. Sem `visivel`, alterna. Esconder só apaga o desenho:
/// microfone, câmera e gestos continuam rodando na janela dela.
#[tauri::command]
fn definir_aura(app: tauri::AppHandle, estado: tauri::State<'_, AuraVisivel>, visivel: Option<bool>) -> bool {
    let nova = visivel.unwrap_or(!estado.ligada.load(Ordering::Relaxed));
    estado.ligada.store(nova, Ordering::Relaxed);
    if let Some(item) = estado.item.lock().unwrap().as_ref() {
        let _ = item.set_checked(nova);
    }
    let _ = app.emit("aura-visivel", nova);
    nova
}

/// Gesto diagonal na aura: mesmo efeito do "Centralizar aura" do menu.
#[tauri::command]
fn aura_centralizar(app: tauri::AppHandle) {
    centralizar_aura(&app);
}

#[tauri::command]
fn close_context_map(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

fn main() {
    // Segurar Option + Espaço = falar (solta pra enviar).
    let falar = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let gesto_ativo = Arc::new(AtomicBool::new(true));
    let gesto_ativo_evento = Arc::clone(&gesto_ativo);

    tauri::Builder::default()
        .manage(GestoAtivo(Arc::clone(&gesto_ativo)))
        .manage(ItemGestos(std::sync::Mutex::new(None)))
        .manage(MicLigado { ligado: AtomicBool::new(true), item: std::sync::Mutex::new(None) })
        .manage(ilha::AreaIlha::default())
        .manage(AuraVisivel { ligada: AtomicBool::new(true), item: std::sync::Mutex::new(None) })
        .manage(servicos::Servicos::default())
        // Abrir junto com o Mac (LaunchAgent); liga e desliga no menu da barra.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .on_window_event(move |window, event| {
            // Minimizar o mapa = voltar pro Teko: fecha a janela (o Destroyed abaixo traz a aura de volta).
            // No macOS nem sempre vem Resized ao minimizar; perder o foco sempre vem, então confere
            // de novo meio segundo depois (a animação de minimizar termina nesse tempo).
            if window.label() == "context-map" {
                match event {
                    tauri::WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
                        let _ = window.close();
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let mapa = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            if mapa.is_minimized().unwrap_or(false) {
                                let _ = mapa.close();
                            }
                        });
                    }
                    _ => {}
                }
            }
            if window.label() == "context-map" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(aura) = window.app_handle().get_webview_window("aura") {
                    let _ = aura.show();
                }
                if gesto_ativo_evento.load(Ordering::Relaxed) {
                    let _ = window.app_handle().emit("gestos", true);
                }
            }
        })
        .on_permission_request(|_, kind| match kind {
            // O Teko solicita captura só para voz e gesto; o macOS ainda controla a permissão do app.
            PermissionKind::Camera | PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![voice_local_request, open_context_map, close_context_map, definir_esc, chat_stream, approve_tool, aura_geometria, posicionar_aura, aura_centralizar, definir_aura, definir_gestos, sair_teko, definir_microfone, ilha::ilha_info, ilha::ilha_area, ilha::ilha_uso])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &falar {
                        let apertado = event.state() == ShortcutState::Pressed;
                        let _ = app.emit("falar", apertado);
                    } else if shortcut == &Shortcut::new(None, Code::Escape)
                        && event.state() == ShortcutState::Pressed
                    {
                        let _ = app.emit("cancelar", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            app.global_shortcut().register(falar)?;

            // Servidor e voz clonada: sobe o que não estiver no ar (sem travar a abertura).
            let servicos_app = app.handle().clone();
            std::thread::spawn(move || servicos::iniciar(&servicos_app.state::<servicos::Servicos>()));

            // Sem ícone no Dock: o Teko vive na barra de menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // A aura não rouba cliques: o mouse passa direto por ela.
            if let Some(aura) = app.get_webview_window("aura") {
                let _ = aura.set_ignore_cursor_events(true);
                colocar_no_centro(&aura);
            }

            // Ilha no notch: mede o notch na thread principal (o AppKit exige) e cria a janela.
            app.manage(ilha::medir_notch());
            if let Err(err) = ilha::criar(app.handle()) {
                eprintln!("[Teko] não consegui criar a ilha: {err}");
            }
            ilha::vigiar_mouse(app.handle().clone());

            // Escuta do "Teko": ligada ao abrir; desmarcar desliga o microfone.
            let microfone = CheckMenuItem::with_id(app, "microfone", "Microfone ligado", true, true, None::<&str>)?;
            *app.state::<MicLigado>().item.lock().unwrap() = Some(microfone.clone());
            let escuta = CheckMenuItem::with_id(app, "escuta", "Ativar falando \"Teko\"", true, true, None::<&str>)?;
            let estalo = CheckMenuItem::with_id(app, "estalo", "Ligar com estalo de dedos", true, true, None::<&str>)?;
            let mapa = MenuItem::with_id(app, "mapa", "Abrir mapa neural", true, None::<&str>)?;
            let gestos = CheckMenuItem::with_id(app, "gestos", "Reconhecer gesto T automaticamente (câmera)", true, true, None::<&str>)?;
            let ilha_item = CheckMenuItem::with_id(app, "ilha", "Mostrar ilha no notch", true, true, None::<&str>)?;
            let aura_item = CheckMenuItem::with_id(app, "aura", "Mostrar aura", true, true, None::<&str>)?;
            *app.state::<AuraVisivel>().item.lock().unwrap() = Some(aura_item.clone());
            let centralizar = MenuItem::with_id(app, "centralizar", "Centralizar aura", true, None::<&str>)?;
            let dica = MenuItem::with_id(app, "dica", "Ou segure ⌥ Espaço pra falar", false, None::<&str>)?;
            let junto = CheckMenuItem::with_id(app, "login", "Abrir junto com o Mac", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let junto_menu = junto.clone();
            let sair = MenuItem::with_id(app, "sair", "Sair do Teko", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&microfone, &escuta, &estalo, &mapa, &gestos, &ilha_item, &aura_item, &centralizar, &junto, &dica, &sair])?;
            let escuta_menu = escuta.clone();
            let estalo_menu = estalo.clone();
            let gestos_menu = gestos.clone();
            *app.state::<ItemGestos>().0.lock().unwrap() = Some(gestos.clone());
            let ilha_menu = ilha_item.clone();
            let gesto_ativo_menu = Arc::clone(&gesto_ativo);
            // Ícone da barra no estilo do macOS (Bluetooth, Wi-Fi): desenho só em preto com fundo
            // transparente, marcado como template; o sistema pinta de branco ou preto conforme a barra.
            let icone_barra = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::new()
                .icon(icone_barra)
                .icon_as_template(true)
                .tooltip("Teko")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "sair" => app.exit(0),
                    "aura" => {
                        // O menu já trocou a marca sozinho: só repassa o novo estado.
                        let estado = app.state::<AuraVisivel>();
                        let marcada = estado.item.lock().unwrap().as_ref().and_then(|i| i.is_checked().ok()).unwrap_or(true);
                        estado.ligada.store(marcada, Ordering::Relaxed);
                        let _ = app.emit("aura-visivel", marcada);
                    }
                    "login" => {
                        let ligar = junto_menu.is_checked().unwrap_or(false);
                        let r = if ligar { app.autolaunch().enable() } else { app.autolaunch().disable() };
                        if let Err(err) = r {
                            eprintln!("[Teko] abrir junto com o Mac: {err}");
                            let _ = junto_menu.set_checked(!ligar);
                        }
                    }
                    "mapa" => {
                        if let Err(err) = open_context_map(app.clone()) {
                            eprintln!("[Teko] não consegui abrir o mapa: {err}");
                        }
                    }
                    "estalo" => {
                        let _ = app.emit("estalo", estalo_menu.is_checked().unwrap_or(true));
                    }
                    "microfone" => {
                        // O menu já trocou a marca sozinho: só repassa o novo estado.
                        let estado = app.state::<MicLigado>();
                        let marcado = estado.item.lock().unwrap().as_ref().and_then(|i| i.is_checked().ok()).unwrap_or(true);
                        estado.ligado.store(marcado, Ordering::Relaxed);
                        let _ = app.emit("microfone", marcado);
                    }
                    "escuta" => {
                        let ligada = escuta_menu.is_checked().unwrap_or(false);
                        let _ = app.emit("escuta", ligada);
                    }
                    "centralizar" => centralizar_aura(app),
                    "ilha" => {
                        if let Some(janela) = app.get_webview_window("ilha") {
                            let _ = if ilha_menu.is_checked().unwrap_or(true) { janela.show() } else { janela.hide() };
                        }
                    }
                    "gestos" => {
                        let ligados = gestos_menu.is_checked().unwrap_or(false);
                        gesto_ativo_menu.store(ligados, Ordering::Relaxed);
                        let _ = app.emit("gestos", ligados);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Teko")
        .run(|app, evento| {
            // Saindo: encerra o servidor e a voz que este app abriu.
            if let tauri::RunEvent::Exit = evento {
                servicos::encerrar(&app.state::<servicos::Servicos>());
            }
        });
}
