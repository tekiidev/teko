// Teko no Mac: app de barra de menu com uma aura transparente por cima de tudo.
// O Rust só cuida do que o navegador não alcança: atalho global, janela e ícone na barra.
// Microfone, aura e conversa com o servidor do Teko ficam no web/ (HTML + JS).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn main() {
    // Segurar Option + Espaço = falar (solta pra enviar).
    let falar = Shortcut::new(Some(Modifiers::ALT), Code::Space);

    tauri::Builder::default()
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

            let sair = MenuItem::with_id(app, "sair", "Sair do Teko", true, None::<&str>)?;
            let dica = MenuItem::with_id(app, "dica", "Segure ⌥ Espaço pra falar", false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&dica, &sair])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .tooltip("Teko")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "sair" {
                        app.exit(0);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Teko");
}
