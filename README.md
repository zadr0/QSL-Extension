# QSL: grammar and Zed analyzer · 0.8

[English editor guide](docs/EDITOR_EN.md) · [Русское руководство](docs/EDITOR_RU.md)

## Русский

Расширение проверяет QSL/DEQ и показывает конкретный план генерации: wire-размеры и смещения, размер Rust-объекта, собственные динамические и заимствованные данные. Доступны inlay-подсказки, наведение на поле, дерево символов, CodeLens для инспектора памяти/событий длины и раскрытия Rust-кода, переходы к константам, дополнение и исправления порядка полей. Ошибка одной схемы не скрывает корректные соседние схемы. Диагностика и интерфейс доступны на RU/EN.

Нативный `qsl-analyze` собирается из той же версии QSL:

```powershell
cargo build --manifest-path qsl/Cargo.toml --release --features rust-macros --bin qsl-analyze --locked
```

Без него оценки предварительные; неизвестные layout внешних типов не подменяются точным sizeof. Размер объекта относится к целевой платформе анализатора, не к фактическому кадру стека функции и не включает аллокаторный запас capacity/RSS.

### Контракт 0.8

- Атрибуты опциональны; обязательные поля всегда перед опциональными.
- `safety` включает проверенное чтение за один проход; без него checked-десериализация не генерируется.
- `aggressive` выбирает встроенные ограниченные строки/массивы. `STACK_LIMIT = 256` по умолчанию строг для **всех** встроенных буферов, включая явные inline/LZ; сверх лимита — String/Vec. Для фиксированного Transmutate нужен явный достаточный лимит.
- `transmutate` разделяет COPY и LIFETIME; наложение требует точного layout, размера, порядка байтов и выравнивания.
- `qps` / `qps=Q2|Q4|Q8|Q16` — точная упаковка самостоятельных чисел, Q16 по умолчанию. Строки, массивы и длины не квантуются; числа находятся перед ними. В подготовленном скалярном чтении частный хвост не требуется.
- `predict_seq` строит индекс по длине; `opt_table` выбирает читателя по тегу. Совместный режим сохраняет граф длин.
- `slots=1..64`, `loyal_cache`, `cache=N` анализируют конечную ёмкость. RT ждёт освобождения занятого пула.
- Числовые optional-поля имеют приватное оптимизированное представление и методы доступа; None не смешивается с Some(0).

## English

This extension validates QSL/DEQ and exposes the concrete generator plan: wire sizes/offsets, Rust object size, owned dynamic data and borrowed data. It includes inlay hints, field hovers, outline, CodeLens inspectors for memory/length events/generated Rust, definitions, completions and field-order fixes. A malformed schema does not hide valid neighbors. UI and diagnostics support RU/EN.

Build the matching native analyzer using the command above. Without it, estimates are advisory; unknown external layouts are never presented as exact sizeof. Native object size refers to the analyzer target, not a function stack frame, spare allocation capacity or RSS.

Version 0.8 makes checked decoding opt-in through safety. Aggressive inline storage, explicit inline/LZ and fixed buffers all obey strict STACK_LIMIT (256 data bytes per buffer by default). Above it COPY uses String/Vec; fixed native Transmutate requires an explicit sufficient limit. COPY and LIFETIME overlays have separate APIs. QPS compresses scalar numeric fields only, defaults to Q16 and never quantizes strings, arrays or their lengths. Scalars must precede them. predict_seq infers state from length; opt_table dispatches by tag. Numeric optional fields use private optimized storage and accessors. RT has per-schema slots and waits on exhaustion. Native layout inspectors show register groups and nested regions.

## Configuration / Конфигурация

```text
!config STACK_LIMIT = 256;
!config MAX_DATA_SIZE = 65535;
!config USE_HASH = xxHash;
!config QSL_RT = true;
!config QSL_RT_DEFAULT = 16;
```

```rust
#[qsl::schem_macro(aggressive_transmutate)]
pub struct Meta { pub id: u64, pub value: u32, pub tag: qsl::InlineString<4> }
```

```qsl
&Packet[safety,aggressive,loyal_cache,slots=4] {
    Meta meta;
    str(1..100) name;
    u32? state;
}
```

Markers belong to Rust definitions, not QSL [macro] attributes. Register source files in build.rs with `build_qsl_files_with_rust`. Nested templates flatten to declaration-order fields while retaining original Rust types. Cycles, collisions, more than 64 expanded fields and required-after-optional order are rejected. Generic/conditional source layouts are not guessed. Native markers reject incompatible repr and dynamic fields. Native regions use `#region(aggressive_transmutate = "Meta"); ... #end_region;`.

The grammar is at the repository root; the Zed extension is in `zed-qsl/`.

```powershell
npm exec --yes --package tree-sitter-cli@0.27.1 -- tree-sitter generate
npm exec --yes --package tree-sitter-cli@0.27.1 -- tree-sitter test
node --test zed-qsl/server/test.js zed-qsl/server/editor.test.js
cargo build --manifest-path zed-qsl/Cargo.toml --release --locked --target wasm32-wasip2
```

The editor discovers nearby DEQ and Rust sources and includes unsaved documents. Registering build inputs explicitly remains authoritative; see the guide for discovery limits and initialization options.
