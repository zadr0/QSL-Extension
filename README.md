# QSL grammar and Zed extension

Tree-sitter grammar is at the repository root; the complete Zed extension is in `zed-qsl/`.

Supported additions: `qps`, `qps=Q2|Q4|Q8|Q16`, unquantized `predict_seq`, `opt_table`, schema-controlled `inline`, `inline=hint|always|never`, and DEQ generation configuration:

```text
!config QSL_RT = true;
!config QSL_RT_DEFAULT = 16;
```

`[macro]` declares an inline field template **and retains its standalone generated Rust structure**. For example, `&Meta[macro]{u64 id;}` and `&Packet{Meta meta;}` produce a standalone `Meta { id }` and a flat `Packet { meta_id }`. Nested/repeated macros expand recursively, with insertion-name prefixes and new incremental tags. Cross-file definitions are resolved over the explicit build input list. The native editor bridge also reads neighboring/open macro definitions. Cycles, expanded-name collisions, more than 64 fields, and depth over 64 are rejected. Optional/default modifiers belong to individual macro fields, not the reference as a group. Encoding flags are chosen independently by the containing schema. No nested-record header or runtime macro expansion is added.

Mechanisms and attributes are opt-in. Field order is mandatory for every schema: required fields first, optional fields last. The language server underlines violations and offers a quickfix. Moving a field changes the wire format; it is never applied automatically.

Checked decoding is generated only for `[safety]`. It is invoked through `validate`, `deserialize_checked`, or `deserialize_checked_into`; ordinary trusted methods do not acquire validation overhead. `inline` is also explicit; the compiler chooses inlining without that attribute. QPS is disabled by default, Q-table compression is explicitly selected, and `QSL_RT` defaults to false.

Hover over a schema to inspect its wire-size limit, static buffer eligibility, 32-bit D budget, index-table size before/after quantization, string encoding, and inline policy. Q2–Q16 compress table indices exactly; they do not round values or lengths. Ambiguous layouts require D or the legacy codec. Explicit unsupported quantization is an error.

The dependency-free Node server provides a preliminary plan. For the exact parser and build plan, build `qsl-analyze` from the matching QSL checkout:

```powershell
cargo build --manifest-path qsl/Cargo.toml --bin qsl-analyze --release --locked
```

With the QSL project as the Zed workspace, the server discovers `qsl/target/release/qsl-analyze.exe` (or the Unix binary). Alternatively set `QSL_ANALYZER` to its absolute path before starting Zed. Unsaved DEQ edits are passed to this analyzer. The conventional configuration lookup is `<schema-name>.deq`, then `schema.deq`, within three ancestor directories. Custom `build.rs` input lists must be checked against the actual build. Preliminary estimates are labelled explicitly.

QSL_RT_DEFAULT is a slot count, not bytes. Only finite-size schemas receive static output regions. Each live lease owns one slot; exhaustion returns PoolExhausted without allocating. The current generator limits static payload storage to 64 MiB per schema. Native validation rejects malformed frames before trusted pointer decoding; custom codecs require their own validator.

## Checks

```powershell
tree-sitter generate --abi 14
tree-sitter test
node --test zed-qsl/server/test.js
cargo build --manifest-path zed-qsl/Cargo.toml --target wasm32-wasip2 --release --locked
```

The native-plan tests run when the adjacent QSL analyzer exists, and are explicitly skipped in a standalone grammar checkout. The stdio LSP test checks diagnostics, hover, and quickfix responses. To use the local extension, choose **Install Dev Extension** in Zed and select `zed-qsl/`. Generated grammar files remain checked in for GitHub consumers.
