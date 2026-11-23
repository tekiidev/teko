// Teko no Mac: app de barra de menu com uma aura transparente por cima de tudo.
// O Rust só cuida do que o navegador não alcança: atalho global, janela e ícone na barra.
// Microfone, aura e conversa com o servidor do Teko ficam no web/ (HTML + JS).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

/// Se o reconhecimento de gestos está ligado no menu; o mapa recebe isso na URL.
struct GestoAtivo(Arc<AtomicBool>);

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
        .invoke_handler(tauri::generate_handler![voice_local_request, open_context_map, close_context_map])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &falar {
                        let apertado = event.state() == ShortcutState::Pressed;
                        let _ = app.emit("falar", apertado);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            app.global_shortcut().register(falar)?;

            // Sem ícone no Dock: o Teko vive na barra de menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // A aura não rouba cliques: o mouse passa direto por ela.
            if let Some(aura) = app.get_webview_window("aura") {
                let _ = aura.set_ignore_cursor_events(true);
            }

            // Escuta do "Teko": ligada ao abrir; desmarcar desliga o microfone.
            let escuta = CheckMenuItem::with_id(app, "escuta", "Ativar falando \"Teko\"", true, true, None::<&str>)?;
            let mapa = MenuItem::with_id(app, "mapa", "Abrir mapa neural", true, None::<&str>)?;
            let gestos = CheckMenuItem::with_id(app, "gestos", "Reconhecer gesto T automaticamente (câmera)", true, true, None::<&str>)?;
            let dica = MenuItem::with_id(app, "dica", "Ou segure ⌥ Espaço pra falar", false, None::<&str>)?;
            let sair = MenuItem::with_id(app, "sair", "Sair do Teko", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&escuta, &mapa, &gestos, &dica, &sair])?;
            let escuta_menu = escuta.clone();
            let gestos_menu = gestos.clone();
            let gesto_ativo_menu = Arc::clone(&gesto_ativo);
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .tooltip("Teko")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "sair" => app.exit(0),
                    "mapa" => {
                        if let Err(err) = open_context_map(app.clone()) {
                            eprintln!("[Teko] não consegui abrir o mapa: {err}");
                        }
                    }
                    "escuta" => {
                        let ligada = escuta_menu.is_checked().unwrap_or(false);
                        let _ = app.emit("escuta", ligada);
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
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Teko");
}
