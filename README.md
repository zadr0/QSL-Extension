# QSL grammar and Zed extension

[Interactive editor guide (EN)](docs/EDITOR_EN.md) · [Интерактивный анализатор (RU)](docs/EDITOR_RU.md)

Version 0.4 adds wire-size/offset inlays, field hovers, CodeLens inspectors, outline, completions, definitions and live RU/EN diagnostics. Enable inlay hints and CodeLens in Zed as shown in the guide.

Tree-sitter grammar is at the repository root; the complete Zed extension is in `zed-qsl/`.

Supported additions: `qps`, `qps=Q2|Q4|Q8|Q16`, exact numeric payload `quant=Q2|Q4|Q8|Q16`, unquantized `predict_seq`, static `opt_table`, schema-controlled `inline`, `inline=hint|always|never`, and DEQ generation configuration:

```text
!config QSL_RT = true;
!config QSL_RT_DEFAULT = 16;
```

Macro markers belong to **Rust declarations**, using the optional QSL `rust-macros` feature:

```rust
#[qsl::qsl_macro]
pub struct Meta { pub id: u64 }
#[qsl::schem_macro]
pub struct Trace { pub meta: Meta, pub kind: u16 }
```

The schema `&Packet { Trace trace; }` generates fields `trace_meta_id` and `trace_kind`. Original Rust types stay nested and unchanged; no duplicate `Meta` or `Trace` type is generated. Register Rust source paths explicitly in `build.rs` with `build_qsl_files_with_rust(qsl_files, deq_files, rust_files, out_dir)`. Nested/repeated templates expand at build time. Cycles, name collisions, more than 64 expanded fields, and depth over 64 are rejected. Group optionality on a template reference is ambiguous and rejected; `Option<T>` belongs to member fields. `[macro]` is not a QSL attribute.

Supported source types include fixed integers, `Option<T>`, `String`, `&str`, `&[u8]`, `[u8; N]`, QSL string wrappers and references to marked structs. Capacities must be literals; arbitrary type/const parameters and conditional `cfg` fields are rejected rather than guessed. Mixed owned `String` and borrowed `&str` require explicit QSL guard types to retain ownership semantics. Source imports use declared, unique type names rather than full Rust name resolution.

Mechanisms and attributes are opt-in. Field order is mandatory for every schema: required fields first, optional fields last. The language server underlines violations and offers a quickfix. Moving a field changes the wire format; it is never applied automatically.

Checked decoding is generated only for `[safety]`. It is invoked through `validate`, `deserialize_checked`, or `deserialize_checked_into`; ordinary trusted methods do not acquire validation overhead. `inline` is also explicit; the compiler chooses inlining without that attribute. QPS is disabled by default, Q-table compression is explicitly selected, and `QSL_RT` defaults to false.

Hover over a schema to inspect its wire-size limit, static buffer eligibility, 32-bit D budget, index-table size before/after quantization, string encoding, and inline policy. Q2–Q16 compress table indices exactly; they do not round values or lengths. Ambiguous layouts require D or the legacy codec. Explicit unsupported quantization is an error.

`[opt_table]` / `[opt_table=static]` analyzes payload length `L` and emits a numeric event index: for two optional bytes, `I = (L > 0) + (L > 1)`. Every critical boundary is derived from schema ranges. The index selects an event function in a module-level static `EVENT_TABLE`. Deterministic handlers never read a tag; ambiguous handlers read only the remaining field-state information. Adjacent equivalent intervals are merged. Larger selectors use a statically unrolled numeric hierarchy rather than one table entry for every payload byte.

Metadata has a known separate span and is excluded from `L`. Bounded raw strings use native length words in that span, without bit extraction; the last variable field derives its length from the payload remainder. Skipping a tag **read** does not remove its reserved wire byte. `[opt_table,predict_seq]` keeps the same format but generates direct mask expressions instead of the indirect event call; Rust inlining is independently controlled by `inline`. Generic analysis is bounded to 12 fields / 65535 payload bytes; equal fixed widths are handled directly up to 64 fields. Unsupported layouts keep the explicit fallback codec. `[opt_table=legacy]` retains the previous per-message offset directory. Updating modes or metadata layout requires matching schemas on both peers.

`[quant=Q16]` is independent of Q_table: it packs bounded integer ranks, retaining the exact quotient **and** remainder. For example, eight `u64(0..15)` fields occupy 4 payload bytes rather than 64. Hover shows the raw/packed upper bounds, private initialized padding and raw fallback reason. Unsupported fields or no physical buffer saving keep the original codec. Restoration uses a separate larger native destination; prepared/RT buffers are reusable. Padding is never transmitted. `predict_seq` byte-length inference and Q_table lookup cannot be applied to this packed representation; use static bit-prefix `opt_table` or plain `qps` (a 32-bit D) alongside `quant`. Prepared pointer decoding requires its explicitly declared initialized tail; exact-slice checked decoding does not.

The dependency-free Node server provides a preliminary plan. For the exact parser and build plan, build `qsl-analyze` from the matching QSL checkout:

```powershell
cargo build --manifest-path qsl/Cargo.toml --bin qsl-analyze --features rust-macros --release --locked
```

With the QSL project as the Zed workspace, the server discovers `qsl/target/release/qsl-analyze.exe` (or the Unix binary). Alternatively set `QSL_ANALYZER` before starting Zed. Rust files next to a schema and in adjacent `src/` directories are discovered within a bounded budget. Unsaved Rust text supplied to the server and unsaved DEQ edits are included in native analysis. A length-prefixed internal source bundle avoids Windows command-line size limits; it is separate from QSL wire format. This discovery is advisory: the explicit `build.rs` input list determines the actual build. Preliminary plans are labelled explicitly.

QSL_RT_DEFAULT is a slot count, not bytes. Only finite-size schemas receive static output regions. Each live lease owns one slot; exhaustion returns PoolExhausted without allocating. The current generator limits static payload storage to 64 MiB per schema. Native validation rejects malformed frames before trusted pointer decoding; custom codecs require their own validator.

## Checks

```powershell
tree-sitter generate --abi 14
tree-sitter test
node --test zed-qsl/server/test.js zed-qsl/server/editor.test.js
cargo build --manifest-path zed-qsl/Cargo.toml --target wasm32-wasip2 --release --locked
```

The native-plan tests run when the adjacent QSL analyzer exists, and are explicitly skipped in a standalone grammar checkout. The stdio LSP test checks diagnostics, hover, and quickfix responses. To use the local extension, choose **Install Dev Extension** in Zed and select `zed-qsl/`. Generated grammar files remain checked in for GitHub consumers.
