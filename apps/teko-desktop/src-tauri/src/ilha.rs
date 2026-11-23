// Ilha do Teko no notch: uma janela transparente colada no topo da tela, acima da barra
// de menu. O desenho fica no web/ilha.html; aqui só fica o que o navegador não alcança:
// medir o notch, subir a janela acima da barra e deixar o mouse passar fora da pílula.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Janela maior que a pílula: o espaço sobrando é transparente e o mouse passa por ele.
const LARGURA: f64 = 440.0;
const ALTURA: f64 = 250.0;

/// Tamanho atual da pílula (em pontos), avisado pelo ilha.js a cada mudança.
#[derive(Default)]
pub struct AreaIlha(pub Mutex<(f64, f64)>);

#[derive(Clone, serde::Serialize)]
pub struct InfoIlha {
    pub tem_notch: bool,
    pub largura: f64,
    pub altura: f64,
}

/// Medida do notch da tela principal. Sem notch, uma pílula pequena no topo central.
#[cfg(target_os = "macos")]
pub fn medir_notch() -> InfoIlha {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    let sem = InfoIlha { tem_notch: false, largura: 160.0, altura: 24.0 };
    let Some(mtm) = MainThreadMarker::new() else { return sem };
    // A primeira tela da lista é a que tem a barra de menu.
    let Some(tela) = NSScreen::screens(mtm).firstObject() else { return sem };
    let topo = tela.safeAreaInsets().top;
    if topo <= 0.0 {
        return sem;
    }
    let esquerda = tela.auxiliaryTopLeftArea();
    let direita = tela.auxiliaryTopRightArea();
    let largura = tela.frame().size.width - esquerda.size.width - direita.size.width;
    InfoIlha { tem_notch: largura > 40.0, largura: largura.max(120.0), altura: topo }
}

#[cfg(not(target_os = "macos"))]
pub fn medir_notch() -> InfoIlha {
    InfoIlha { tem_notch: false, largura: 160.0, altura: 24.0 }
}

/// Sobe a janela pro nível da barra de status (acima da barra de menu) e deixa ela em
/// todas as mesas, inclusive com app em tela cheia.
#[cfg(target_os = "macos")]
fn acima_da_barra(janela: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = janela.ns_window() else { return };
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    ns.setLevel(25); // NSStatusWindowLevel
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns.setHasShadow(false);
}

#[cfg(not(target_os = "macos"))]
fn acima_da_barra(_janela: &tauri::WebviewWindow) {}

pub fn criar(app: &AppHandle) -> tauri::Result<()> {
    let janela = WebviewWindowBuilder::new(app, "ilha", WebviewUrl::App("ilha.html".into()))
        .title("Teko · ilha")
        .inner_size(LARGURA, ALTURA)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        // Sem isso o macOS gasta o primeiro clique só pra ativar a janela e o botão não recebe nada.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    posicionar(&janela);
    acima_da_barra(&janela);
    janela.set_ignore_cursor_events(true)?;
    janela.show()?;
    Ok(())
}

/// Centro do topo da tela principal (onde fica o notch).
fn posicionar(janela: &tauri::WebviewWindow) {
    let Ok(Some(tela)) = janela.primary_monitor() else { return };
    let escala = tela.scale_factor();
    let pos = tela.position().to_logical::<f64>(escala);
    let tam = tela.size().to_logical::<f64>(escala);
    let _ = janela.set_size(LogicalSize::new(LARGURA, ALTURA));
    let _ = janela.set_position(LogicalPosition::new(pos.x + (tam.width - LARGURA) / 2.0, pos.y));
}

/// O mouse para na ilha só em cima da pílula; no resto da janela ele passa direto
/// (senão ela bloquearia a barra de menu). Confere a posição do cursor algumas vezes por segundo.
pub fn vigiar_mouse(app: AppHandle) {
    std::thread::spawn(move || {
        let mut dentro = false;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let Some(janela) = app.get_webview_window("ilha") else { continue };
            if !janela.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(cursor), Ok(pos), Ok(tam), Ok(escala)) =
                (app.cursor_position(), janela.outer_position(), janela.outer_size(), janela.scale_factor())
            else {
                continue;
            };
            let (w, h) = *app.state::<AreaIlha>().0.lock().unwrap();
            let centro = pos.x as f64 + tam.width as f64 / 2.0;
            let topo = pos.y as f64;
            let agora = (cursor.x - centro).abs() <= w * escala / 2.0 && cursor.y >= topo && cursor.y <= topo + h * escala;
            if agora != dentro {
                dentro = agora;
                let _ = janela.set_ignore_cursor_events(!agora);
                let _ = janela.emit_to("ilha", "ilha-mouse", agora);
            }
        }
    });
}

/// Gasto do dia pra ilha. Passa pelo Rust porque o WebView não deixa a página do app
/// (tauri://, segura) chamar http://127.0.0.1 direto.
#[tauri::command]
pub async fn ilha_uso() -> Result<String, String> {
    let resposta = reqwest::Client::new()
        .get("http://127.0.0.1:4780/api/usage")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| format!("servidor fora do ar: {err}"))?;
    if !resposta.status().is_success() {
        return Err(format!("servidor respondeu HTTP {}", resposta.status()));
    }
    resposta.text().await.map_err(|err| err.to_string())
}

#[tauri::command]
pub fn ilha_info(info: tauri::State<'_, InfoIlha>) -> InfoIlha {
    info.inner().clone()
}

#[tauri::command]
pub fn ilha_area(area: tauri::State<'_, AreaIlha>, largura: f64, altura: f64) {
    *area.0.lock().unwrap() = (largura.clamp(0.0, LARGURA), altura.clamp(0.0, ALTURA));
}
