# Interactive QSL analysis in Zed

[Русский](EDITOR_RU.md)

QSL 0.4 uses standard editor features instead of a single prose tooltip.

| Where | What is shown |
|---|---|
| Closing schema brace | Frame size or an explicit dynamic/unbounded range |
| Field declaration | Encoded size and known wire offset, including bits |
| Field hover | Rust type, bounds on size/offset, optionality, tag, memory behavior |
| Schema hover | Compact frame/metadata/RT/validation summary and field table |
| CodeLens / Code Actions | Open layout, explore length events, expand generated Rust |
| Outline | Schemas, fields and DEQ constants |
| Completion | Field types, schema attributes, their values and string modifiers |
| Go to Definition | Local schemas, loaded DEQ constants and discovered Rust templates |
| Diagnostics | Syntax, ranges, duplicate declarations, required-before-optional order and unsupported combinations |

Layout inspection opens a Markdown document in Zed's analysis cache. It contains the complete wire-field table and length-event states, without changing the schema. Rust expansion opens the actual generator output; the matching native analyzer is required. Code actions also offer an explicit fixed-prefix reordering when safe, and switching RU/EN for the current server session. Reordering changes wire format and is never automatic. A rewrite that would discard intervening comments is not offered.

## Enable visible hints

Zed disables inlay hints and CodeLens by default. Merge the following into project `.zed/settings.json` or user settings; preserve existing settings. `language` accepts `ru`, `en`, or `auto`. Auto uses the client's locale when supplied, otherwise the system locale. Persistent language choice belongs in settings; the code action only changes the current session.

```json
{
  "code_lens": "on",
  "languages": {
    "QSL": { "inlay_hints": { "enabled": true } },
    "DEQ": { "inlay_hints": { "enabled": true } }
  },
  "lsp": {
    "qsl-lsp": {
      "initialization_options": {
        "language": "en",
        "inlayHints": { "enabled": true, "schemas": true, "fields": true, "offsets": true },
        "codeLens": true
      }
    }
  }
}
```

`inlayHints.schemas`, `fields`, `offsets` and `codeLens` are independent switches. Updating initialization options requires restarting the language server. The server also accepts `workspace/didChangeConfiguration`. Zed settings: [language-server configuration](https://zed.dev/docs/configuring-languages), [inlay hints and CodeLens](https://zed.dev/docs/reference/all-settings).

## Exact native analysis

Build from the matching QSL checkout:

```powershell
cargo build --manifest-path qsl/Cargo.toml --bin qsl-analyze --features rust-macros --release --locked
```

The server looks in the workspace and parent directories of the current document, including `qsl/target/release/` and `target/release/`. Set `initialization_options.analyzerPath` or `QSL_ANALYZER` for an explicit binary. Capability probing rejects an incompatible bridge and leaves labelled advisory estimates. Failed subprocesses, malformed responses and server exceptions are reported rather than silently ignored.

DEQ and Rust-template file changes invalidate editor analysis; unsaved DEQ values are included. Rust source discovery is bounded and advisory: build.rs still defines the build input list. Syntax/range diagnostics from the editor are retained when native parsing succeeds. Invalid schemas do not get authoritative layout hints. Unknown offsets are omitted from inlays instead of repeated as unknown values.

Wire size is not `size_of::<T>()`. Rust can reorder fields and add padding; exact native layout belongs to rustc. The inspector does not invent a Rust object size or claim that an unknown custom codec is unbounded. Compact or custom fields whose bounds are unresolved are shown explicitly as dynamic/unknown. Compression results are not predicted from Q alone.

Try [inspect.qsl](../zed-qsl/examples/inspect.qsl). The static graph distinguishes forced/possible presence, reserved metadata and payload. Q2–Q16 payload values remain lossless. No benchmark is run by any editor command.

## Verify

```powershell
node --test zed-qsl/server/test.js zed-qsl/server/editor.test.js
tree-sitter test
cargo build --manifest-path zed-qsl/Cargo.toml --target wasm32-wasip2 --release --locked
```

Protocol tests check both languages, changing/fixing errors, inlays, field hovers, outline, completions, definitions, configuration changes, UTF-16 edits and opening layout/generated source. Native-specific tests are explicitly skipped without an adjacent native analyzer.

With the default Windows Zed keymap, `Ctrl+.` opens code actions.
