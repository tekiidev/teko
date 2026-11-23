fn main() {
    // Caminho do Node no momento da compilação: quando o Mac abre o Teko sozinho (login),
    // o PATH é mínimo e não acha o Node do nvm. O app usa esse caminho pra subir o servidor.
    println!("cargo:rerun-if-env-changed=PATH");
    if let Some(node) = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|n| n.is_file())) {
        println!("cargo:rustc-env=TEKO_NODE={}", node.display());
    }

    // Declara os comandos do app no ACL do Tauri. Com isso cada janela só chama
    // os comandos liberados na capability dela (capabilities/*.json). A janela do
    // mapa carrega do Teko local por URL (origem "remota") e precisa disso pra
    // conseguir chamar o close_context_map.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["voice_local_request", "open_context_map", "close_context_map", "definir_esc", "chat_stream", "approve_tool", "aura_geometria", "posicionar_aura", "aura_centralizar", "ilha_info", "ilha_area", "ilha_uso"]),
    ))
    .expect("falha no tauri-build");
}
