/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

module.exports = grammar({
  name: "qsl",

  extras: ($) => [/\s/, $.comment],

  rules: {
    source_file: ($) => repeat(choice($.struct_declaration, $.define_statement, $.config_statement)),

    config_statement: ($) => seq("!config",field("name",$.identifier),"=",field("value",$._expression),";"),

    // !define CONST: T = VALUE;   (used in .deq files)
    define_statement: ($) =>
      seq(
        "!define",
        field("name", $.identifier),
        ":",
        field("type", $.type),
        "=",
        field("value", $._define_value),
        ";",
      ),

    _define_value: ($) => choice($._expression, $.array_literal),

    array_literal: ($) =>
      seq("[", optional(commaSep1($._define_value)), "]"),

    // & User[alignment] { ... }
    struct_declaration: ($) =>
      seq(
        "&",
        field("name", $.identifier),
        optional(field("attributes", $.struct_attributes)),
        field("body", $.struct_body),
      ),

    // [alignment] / [alignment=8, packed]
    struct_attributes: ($) => seq("[", optional(commaSep1($.attribute)), "]"),

    attribute: ($) =>
      seq(
        field("key", $.identifier),
        optional(seq("=", field("value", $._value))),
      ),

    struct_body: ($) => seq("{", repeat($._member), "}"),

    _member: ($) => choice($.field, $.directive),

    // #padding_bits=24;
    directive: ($) =>
      seq(
        "#",
        field("name", $.identifier),
        optional(seq("=", field("value", $._value))),
        ";",
      ),

    // arr<u32>?(3) vec|a=1|b|;
    field: ($) =>
      seq(
        field("type", $.type),
        field("name", $.identifier),
        optional(field("modifiers", $.modifiers)),
        ";",
      ),

    type: ($) =>
      seq(
        field("name", $.identifier),
        optional($.type_arguments),
        optional($.optional_marker),
        optional($.size),
      ),

    type_arguments: ($) => seq("<", commaSep1($.type), ">"),

    optional_marker: (_) => "?",

    // (N) or (A..B)
    size: ($) => seq("(", choice($.range, $._bound), ")"),

    range: ($) => seq(field("start", $._bound), "..", field("end", $._bound)),

    _bound: ($) => $._expression,

    // |default=!D_FLAGS|  (also |a=1|b=2|)
    modifiers: ($) => repeat1(seq("|",$.modifier,"|")),

    modifier: ($) =>
      seq(
        field("key", $.identifier),
        optional(seq("=", field("value", $._value))),
      ),

    _value: ($) => $._expression,
    _expression: ($) => choice($.constant,$.number,$.string,$.quantum,$.identifier,$.binary_expression,$.unary_expression,$.sizeof_expression,$.parenthesized_expression),
    // A named operand, not a precision or an implicit payload mode.
    quantum: (_) => token(prec(1,/Q(16|8|4|2|1)/)),
    binary_expression: ($) => choice(
      prec.left(1,seq($._expression,choice("+","-"),$._expression)),
      prec.left(2,seq($._expression,choice("*","/","%"),$._expression))),
    unary_expression: ($) => prec(3,seq(choice("+","-"),$._expression)),
    sizeof_expression: ($) => seq("sizeof","(",$.identifier,")"),
    parenthesized_expression: ($) => seq("(",$._expression,")"),

    // !D_FLAGS
    constant: (_) => token(seq("!", /[A-Za-z_][A-Za-z0-9_]*/)),

    number: (_) =>
      token(
        choice(
          /-?0[xX][0-9a-fA-F_]+/,
          /-?0[bB][01_]+/,
          /-?[0-9][0-9_]*\.[0-9][0-9_]*/,
          /-?[0-9][0-9_]*/,
        ),
      ),

    string: (_) => token(seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,

    comment: (_) =>
      token(choice(seq("//", /[^\n]*/), seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/"))),
  },
});
