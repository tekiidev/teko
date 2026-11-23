fn main() {
    // Declara os comandos do app no ACL do Tauri. Com isso cada janela só chama
    // os comandos liberados na capability dela (capabilities/*.json). A janela do
    // mapa carrega do Teko local por URL (origem "remota") e precisa disso pra
    // conseguir chamar o close_context_map.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["voice_local_request", "open_context_map", "close_context_map", "definir_esc", "chat_stream", "approve_tool"]),
    ))
    .expect("falha no tauri-build");
}
