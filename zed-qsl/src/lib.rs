use std::{env, fs};
use zed_extension_api::{self as zed, LanguageServerId, Result};

// The language server is embedded in the extension and written to the
// extension's work directory on startup, then run with Zed's bundled Node.js.
const SERVER_JS: &str = include_str!("../server/qsl-server.js");
const LAYOUT_JS: &str = include_str!("../server/layout-engine.js");

struct QslExtension;

impl zed::Extension for QslExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let dir = env::current_dir().map_err(|e| e.to_string())?;
        let script = dir.join("qsl-server.js");
        fs::write(&script, SERVER_JS).map_err(|e| format!("failed to write server: {e}"))?;
        fs::write(dir.join("layout-engine.js"), LAYOUT_JS).map_err(|e| e.to_string())?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(QslExtension);
