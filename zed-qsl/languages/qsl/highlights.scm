; Rust-like highlighting for QSL

; comments
(comment) @comment
((comment) @comment.doc
  (#match? @comment.doc "^(///|/\\*\\*)"))

; structs
(struct_declaration "&" @keyword)
(struct_declaration name: (identifier) @type)
(attribute key: (identifier) @attribute)

; types (primitives and user types are both @type, as in Rust)
(type name: (identifier) @type)

; fields
(field name: (identifier) @property)

; #directive=...;  (like Rust's #[attribute])
(directive "#" @attribute)
(directive name: (identifier) @attribute)

; |modifier=value|
(modifier key: (identifier) @attribute)

; !define CONST: T = VALUE;
(define_statement "!define" @keyword)
(define_statement name: (identifier) @constant)
(config_statement "!config" @keyword)
(config_statement name: (identifier) @constant)

; values
(number) @number
(string) @string
(constant) @constant

((identifier) @boolean
  (#match? @boolean "^(true|false)$"))

; SCREAMING_CASE identifiers are constants, like in Rust
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))

; operators and punctuation
(optional_marker) @operator
["=" ".." "+" "-" "*" "/" "%"] @operator
["{" "}" "[" "]" "(" ")" "<" ">"] @punctuation.bracket
["|" ";" "," ":"] @punctuation.delimiter
