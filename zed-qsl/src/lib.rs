use std::{env, fs};
use zed_extension_api::{self as zed, LanguageServerId, Result};

// The language server is embedded in the extension and written to the
// extension's work directory on startup, then run with Zed's bundled Node.js.
const SERVER_JS: &str = include_str!("../server/qsl-server.js");
const LAYOUT_JS: &str = include_str!("../server/layout-engine.js");
const UI_JS: &str = include_str!("../server/editor-features.js");
const I18N_JS: &str = include_str!("../server/i18n.js");

struct QslExtension;

impl zed::Extension for QslExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let dir = env::current_dir().map_err(|e| e.to_string())?;
        let script = dir.join("qsl-server.js");
        fs::write(&script, SERVER_JS).map_err(|e| format!("failed to write server: {e}"))?;
        fs::write(dir.join("layout-engine.js"), LAYOUT_JS).map_err(|e| e.to_string())?;

        fs::write(dir.join("editor-features.js"), UI_JS).map_err(|e| e.to_string())?;
        fs::write(dir.join("i18n.js"), I18N_JS).map_err(|e| e.to_string())?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script.to_string_lossy().to_string()],
            env: vec![
                ("QSL_WORKTREE_ROOT".into(), worktree.root_path()),
                (
                    "QSL_ANALYSIS_DIR".into(),
                    dir.join("analysis").to_string_lossy().into_owned(),
                ),
            ],
        })
    }
    fn language_server_initialization_options(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(zed::settings::LspSettings::for_worktree(id.as_ref(), worktree)?.initialization_options)
    }
    fn language_server_workspace_configuration(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(zed::settings::LspSettings::for_worktree(id.as_ref(), worktree)?.settings)
    }
}

zed::register_extension!(QslExtension);
