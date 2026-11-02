# QSL grammar and Zed extension

[Interactive editor guide (EN)](docs/EDITOR_EN.md) · [Интерактивный анализатор (RU)](docs/EDITOR_RU.md)

Version 0.6 adds general byte-operand QPS APIs and single-u8 warnings, and separates QPS operand compression from opt_table prediction and adds wire-size/offset inlays, field hovers, CodeLens inspectors, outline, completions, definitions and live RU/EN diagnostics. Enable inlay hints and CodeLens in Zed as shown in the guide.

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

Checked decoding is generated only for `[safety]`. It is invoked through `validate`, `deserialize_checked`, or `deserialize_checked_into`; ordinary trusted methods do not acquire validation overhead. `inline` is also explicit; the compiler chooses inlining without that attribute. QPS is disabled by default; `[qps]` selects Q16, and `QSL_RT` defaults to false.

Hover over a schema to inspect wire-size limits, RT eligibility, numeric operand widths, optional-state metadata, strings and inline policy. Macro references show all expanded members rather than a misleading first-child size. QPS does not require optional fields. Native analysis requires `qpsCodecRevision: 2`; an older binary leaves explicitly labelled advisory estimates.

`[opt_table]` / `[opt_table=static]` analyzes payload length `L` and emits a numeric event index: for two optional bytes, `I = (L > 0) + (L > 1)`. Every critical boundary is derived from schema ranges. The index selects an event function in a module-level static `EVENT_TABLE`. Deterministic handlers never read a tag; ambiguous handlers read only the remaining field-state information. Adjacent equivalent intervals are merged. Larger selectors use a statically unrolled numeric hierarchy rather than one table entry for every payload byte.

Metadata has a known separate span and is excluded from `L`. Bounded raw strings use native length words in that span, without bit extraction; the last variable field derives its length from the payload remainder. Skipping a tag **read** does not remove its reserved wire byte. `[opt_table,predict_seq]` keeps the same format but generates direct mask expressions instead of the indirect event call; Rust inlining is independently controlled by `inline`. Generic analysis is bounded to 12 fields / 65535 payload bytes; equal fixed widths are handled directly up to 64 fields. Unsupported layouts keep the explicit fallback codec. `[opt_table=legacy]` retains the previous per-message offset directory. Updating modes or metadata layout requires matching schemas on both peers.

`[qps]` defaults to Q16; explicit `[qps=Q2]`, Q4, Q8 and Q16 are supported. `[quant=Qn]` is a compatible alias; specifying both is rejected. QPS packs bounded integer ranks using a numeric divisor and preserves both quotient and remainder. It is compression, not presence prediction. For a rank `r = x - min` of width B, `k = min(log2(Q), B)`, `u = r >> k`, `v = r & ((1 << k) - 1)`, and `code = u | (v << (B-k))`. The inverse restores r exactly. Constant domains use no value bits. Q can change encoded bytes without changing total length; savings come from the bounded domain and packing.

For example, eight `u64(0..15)` values use 4 payload bytes instead of 64. Optional fields remain optional; `opt_table` independently selects their length/offset graph and uses bit-prefix handling for a packed layout. Unsupported fields or no physical buffer saving keep an explicitly reported raw fallback. Restoration writes into a separate larger native destination. Prepared/RT buffers can be reused; initialized private tail bytes are never transmitted. Checked exact-slice decoding does not require the prepared pointer API's extra tail.

The old D/u32 and quantized-index representation is available only through explicit `[state_bits]` / `[state_bits=Q1|Q2|Q4|Q8|Q16]` for compatibility. It is not new QPS. Changing codec or quantum changes format identity; both peers must use the same schema and configuration.

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

## General byte QPS (RU / EN)

QPS does not predict presence. `opt_table` owns length prediction. In addition to scalar specialization, checked schemas can use `ByteQps<Q>` over their entire serialized bytes, including UTF-8 and arrays. `[qps,safety]` generates explicit `serialize_qps_to(scratch,out)` and owned `deserialize_qps_into(input,restoration,out)`; borrowed schemas use `deserialize_qps` and borrow the restored region. Existing `Serializable` bytes are not silently replaced. The 16 B QPB3 envelope stores original length without quantization. Raw fallback pays the explicit framing cost; grouping four unrestricted u8 values does not guarantee fewer than 32 bits. Hover distinguishes scalar specialization, general byte APIs and prediction. A single u8 without a scalar saving receives a warning, not a schema error. The native bridge requires byte codec revision 3.

QPS не предиктует поля: длину анализирует `opt_table`. Помимо числовой специализации, `ByteQps<Q>` работает со всем сериализованным payload, включая UTF-8 и массивы. Для `[qps,safety]` доступны явные методы общего кодека с scratch/output/restoration. Заимствованный результат живёт в восстановленном регионе. Существующий `Serializable` не меняет формат неявно. Заголовок QPB3 занимает 16 B и хранит исходную длину без квантования. Для raw-режима цена заголовка показывается явно. Объединение четырёх произвольных u8 не гарантирует сжатия 32 бит. В hover разделены специализация, общие API и предиктование; одиночный u8 без выигрыша получает предупреждение.
