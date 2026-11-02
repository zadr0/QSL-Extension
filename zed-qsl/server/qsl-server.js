#!/usr/bin/env node
// QSL language server (stdio, no dependencies). Diagnostics for .qsl and .deq files.
"use strict";
const fs = require("fs");
const {spawnSync}=require("child_process");
const layout=require("./layout-engine");
const ui=require("./editor-features");
const i18n=require("./i18n");
const path = require("path");
const { fileURLToPath } = require("url");

// ---- Language tables (edit to match your language) ---------------------------
const INT_RE = /^([ui])(8|16|32|64)$/;
// number of type arguments a builtin takes (default 0)
const TYPE_ARITY = { arr: 1, array: 1, vec: 1 };
// which size forms each type category accepts: "range" = (A..B), "n" = (N)
const SIZE_RULES = {
  int: ["range"],
  float: ["range"],
  text: ["range", "n"],
  array: ["range", "n"],
  flags: ["n"],     // assumption: bit width, e.g. flags(8)
  scalar: [],       // bool, char
  user: [],
};
function categoryOf(n) {
  if (INT_RE.test(n)) return "int";
  if (n === "f32" || n === "f64") return "float";
  if (n === "str" || n === "string" || n === "String") return "text";
  if (["arr","array","vec"].includes(n)) return "array";
  if (n === "flags") return "flags";
  if (n === "bool" || n === "char") return "scalar";
  return "user";
}
const isBuiltin = (n) => categoryOf(n) !== "user";
// -----------------------------------------------------------------------------

const ERROR = 1, WARNING = 2;
const PUNCT = new Set("&{}[]()<>?|;,=#:+-*/%".split(""));
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const RE_CONST = /![A-Za-z_][A-Za-z0-9_]*/y;
const RE_NUM = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*\.[0-9][0-9_]*|[0-9][0-9_]*/y;

function match(re, text, i) {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : null;
}

// ---- numbers ---------------------------------------------------------------
const isFloatLit = (x) => x.includes(".");
function parseBig(x) {
  const neg = x.startsWith("-");
  const b = BigInt(x.replace(/^-/, "").replace(/_/g, ""));
  return neg ? -b : b;
}
const numVal = (x) => (isFloatLit(x) ? Number(x.replace(/_/g, "")) : parseBig(x));
const cmp = (a, b) => {
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  a = Number(a); b = Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
};
function intLimits(n) {
  const m = INT_RE.exec(n);
  if (!m) return null;
  const bits = BigInt(m[2]);
  return m[1] === "i"
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n }
    : { min: 0n, max: (1n << bits) - 1n };
}

// ---- tokenizer -------------------------------------------------------------
function tokenize(text, diags) {
  const toks = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) {
        diags.push({ s: i, e: i + 2, m: "Unterminated block comment", sev: ERROR });
        i = n;
      } else i = e + 2;
      continue;
    }
    if (c === '"') {
      const s = i++;
      while (i < n && text[i] !== '"' && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      if (text[i] === '"') i++;
      else {
        i = Math.min(i, n);
        diags.push({ s, e: i, m: "Unterminated string literal", sev: ERROR });
      }
      toks.push({ t: "string", s, e: i, x: text.slice(s, i) });
      continue;
    }
    if (c === "." && text[i + 1] === ".") {
      toks.push({ t: "p", s: i, e: i + 2, x: ".." }); i += 2; continue;
    }
    let x;
    if (c === "!" && (x = match(RE_CONST, text, i))) {
      toks.push({ t: ["!define","!config"].includes(x) ? "kw" : "const", s: i, e: i + x.length, x });
      i += x.length;
      continue;
    }
    if ((x = match(RE_NUM, text, i))) {
      const s = i;
      i += x.length;
      toks.push({ t: "number", s, e: i, x });
      const bad = match(RE_IDENT, text, i);
      if (bad) {
        diags.push({ s, e: i + bad.length, m: `Invalid number literal '${x}${bad}'`, sev: ERROR });
        i += bad.length;
      }
      continue;
    }
    if ((x = match(RE_IDENT, text, i))) {
      toks.push({ t: "ident", s: i, e: i + x.length, x }); i += x.length; continue;
    }
    if (PUNCT.has(c)) {
      toks.push({ t: "p", s: i, e: i + 1, x: c }); i++; continue;
    }
    diags.push({ s: i, e: i + 1, m: `Unexpected character '${c}'`, sev: ERROR });
    i++;
  }
  return toks;
}

// opts: { kind: "qsl" | "deq", known: Set<string> | null }
function analyze(text, opts = {}) {
  const kind = opts.kind || "qsl";
  const diags = [];
  const toks = tokenize(text, diags);
  const len = toks.length;
  let p = 0;

  const structs = [];
  const configs={...(opts.configs||{})};
  const defs = [];
  const typeChecks = [];

  const err = (s, e, m, sev = ERROR) => diags.push({ s, e, m, sev });
  const isP = (x) => p < len && toks[p].t === "p" && toks[p].x === x;
  const isKw = () => p < len && toks[p].t === "kw";
  const prevEnd = () => (p > 0 ? toks[p - 1].e : 0);
  const errHere = (m) => {
    if (p < len) err(toks[p].s, toks[p].e, m);
    else err(Math.max(0, text.length - 1), text.length, m + " (unexpected end of file)");
  };
  const errAfterPrev = (m) => err(Math.max(0, prevEnd() - 1), prevEnd(), m);

  function expectP(x) {
    if (isP(x)) return toks[p++];
    if (x === ";") errAfterPrev("Expected ';'");
    else errHere(`Expected '${x}'` + (p < len ? `, found '${toks[p].x}'` : ""));
    return null;
  }
  function expectIdent(what) {
    if (p < len && toks[p].t === "ident") return toks[p++];
    errHere(`Expected ${what}` + (p < len ? `, found '${toks[p].x}'` : ""));
    return null;
  }
  function sync() {
    while (p < len && !isP(";") && !isP("}") && !isP("&") && !isKw()) p++;
    if (isP(";")) p++;
  }
  function parseValue(minPrec=0) {
    const start=p;
    if(isP("+")||isP("-")){p++;if(!parseValue(3))return null;}
    else if(isP("(")){p++;if(!parseValue())return null;if(!expectP(")"))return null;}
    else if(p<len && ["const","number","string","ident"].includes(toks[p].t)){
      const atom=toks[p++];
      if(atom.x==="sizeof"&&isP("(")){p++;if(!expectIdent("a sizeof type"))return null;if(!expectP(")"))return null;}
    }else{errHere("Expected an expression");return null;}
    for(;;){const op=toks[p]?.x,prec=["+","-"].includes(op)?1:["*","/","%"].includes(op)?2:0;if(!prec||prec<minPrec)break;p++;if(!parseValue(prec+1))return null;}
    if(p===start+1)return toks[start];
    const from=toks[start].s,to=prevEnd(),x=text.slice(from,to);
    return {t:/^[+-]\s*[0-9][0-9_]*$/.test(x)?"number":"expr",s:from,e:to,x:x.replace(/\s/g,"")};
  }
  function parseBound() {return parseValue();}

  function parseType() {
    const name = expectIdent("a type name");
    if (!name) return null;
    const t = { name, args: [], size: null, optional: false };
    if (isP("<")) {
      p++;
      for (;;) {
        const a = parseType();
        if (!a) return null;
        t.args.push(a);
        if (isP(",")) { p++; continue; }
        break;
      }
      if (!expectP(">")) return null;
    }
    if (isP("?")) {t.optional=true;p++;}
    if (isP("(")) {
      const open = toks[p++];
      const lo = parseBound();
      if (!lo) return null;
      if (isP("..")) {
        p++;
        const hi = parseBound();
        if (!hi) return null;
        const close = expectP(")");
        if (!close) return null;
        t.size = { kind: "range", lo, hi, s: open.s, e: close.e };
      } else {
        const close = expectP(")");
        if (!close) return null;
        t.size = { kind: "n", tok: lo, s: open.s, e: close.e };
      }
    }
    typeChecks.push(t);
    return t;
  }

  function parseMember(st) {
    if (isP("#")) {
      p++;
      if (!expectIdent("a directive name")) return sync();
      if (isP("=")) { p++; if (!parseValue()) return sync(); }
      expectP(";");
      return;
    }
    if (p >= len || toks[p].t !== "ident") {
      errHere("Expected a field type or a '#directive'");
      return sync();
    }
    const type = parseType();
    if (!type) return sync();
    const name = expectIdent("a field name");
    if (!name) return sync();
    if (st.fields.has(name.x)) {
      err(name.s, name.e, `Duplicate field '${name.x}' in struct '${st.name ? st.name.x : "?"}'`);
    } else st.fields.set(name.x, {name,type,modifiers:{},start:type.name.s,end:name.e});
    const record=st.fields.get(name.x);
    if (isP("|")) {
      p++;
      if (!(p < len && toks[p].t === "ident")) {
        errHere("Expected a modifier after '|'");
        return sync();
      }
      while (p < len && toks[p].t === "ident") {
        const key=toks[p++];
        let value="true";
        if (isP("=")) { p++; const v=parseValue();if(!v)return sync();value=v.x; }
        record.modifiers[key.x]=value;
        if (!expectP("|")) return sync();
        if(isP("|"))p++;
      }
    }
    expectP(";"); record.end=prevEnd();
  }

  function parseStruct() {
    const amp = toks[p++];
    if (kind === "deq") err(amp.s, amp.e, "Struct declarations are not allowed in .deq files (only '!define')");
    const st = { name: expectIdent("a struct name"), fields: new Map(),attrs:{},start:amp.s,end:text.length };
    if (st.name) structs.push(st);
    if (isP("[")) {
      p++;
      while (p < len && !isP("]") && !isP("{") && !isP("&")) {
        const key=expectIdent("an attribute name");if(!key){p++;continue;}
        let value="";if (isP("=")) {p++;value=parseValue()?.x||"";}
        if(Object.hasOwn(st.attrs,key.x))err(key.s,key.e,`Duplicate schema attribute '${key.x}'`);
        st.attrs[key.x]=value;
        if (isP(",")) p++;
        else if (!isP("]")) { errHere("Expected ',' or ']'"); break; }
      }
      expectP("]");
    }
    const open = expectP("{");
    if (!open) { while (p < len && !isP("&") && !isKw()) p++; return; }
    while (p < len && !isP("}") && !isP("&") && !isKw()) {
      const before = p;
      parseMember(st);
      if (p === before) p++;
    }
    if (isP("}")) st.end=toks[p++].e;
    else err(open.s, open.e, "Unclosed '{': missing '}'");
  }

  function parseDefineValue() {
    if (isP("[")) {
      const open = toks[p++];
      const items = [];
      if (!isP("]")) {
        for (;;) {
          const v = parseDefineValue();
          if (!v) return null;
          items.push(v);
          if (isP(",")) { p++; continue; }
          break;
        }
      }
      const close = expectP("]");
      if (!close) return null;
      return { kind: "array", items, s: open.s, e: close.e };
    }
    const v = parseValue();
    return v ? { kind: "tok", tok: v, s: v.s, e: v.e } : null;
  }

  function syncDefine() {
    while (p < len && !isP(";") && !isKw() && !isP("&")) p++;
    if (isP(";")) p++;
  }

  // !define CONST: T = VALUE;
  function parseDefine() {
    const kw = toks[p++];
    if(kw.x==="!config") {
      const name=expectIdent("a generation configuration name");if(!name)return syncDefine();
      expectP("=");const value=parseValue();expectP(";");
      if(kind!=="deq")err(kw.s,kw.e,"!config belongs in a DEQ file");
      if(name.x==="QSL_RT"&&!/^(true|false)$/.test(value?.x||""))err(name.s,name.e,"QSL_RT expects true or false");
      else if(name.x==="QSL_RT_DEFAULT"&&!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(value?.x||""))err(name.s,name.e,"QSL_RT_DEFAULT must be 1..64 slots");
      else if(!["QSL_RT","QSL_RT_DEFAULT"].includes(name.x))err(name.s,name.e,"Unknown generation configuration");
      if(Object.hasOwn(configs,name.x))err(name.s,name.e,"Duplicate generation configuration");
      configs[name.x]=value?.x;return;
    }
    if (kind === "qsl") err(kw.s, kw.e, "'!define' belongs in a .deq file");
    const name = expectIdent("a constant name");
    if (!name) return syncDefine();
    if (!expectP(":")) return syncDefine();
    const type = parseType();
    if (!type) return syncDefine();
    if (!expectP("=")) return syncDefine();
    const value = parseDefineValue();
    if (!value) return syncDefine();
    expectP(";");
    defs.push({ name, type, value });
  }

  while (p < len) {
    if (isKw()) { parseDefine(); continue; }
    if (isP("&")) { parseStruct(); continue; }
    errHere(kind === "deq"
      ? "Expected '!define CONST: T = VALUE;'"
      : "Expected '&' to start a struct declaration");
    while (p < len && !isP("&") && !isKw()) p++;
  }

  // ---- semantic checks: types ----------------------------------------------
  const declared = new Map();
  for (const st of structs) {
    if (declared.has(st.name.x)) err(st.name.s, st.name.e, `Duplicate struct '${st.name.x}'`);
    else declared.set(st.name.x, st);
  }

  function checkSize(t, cat) {
    const sz = t.size;
    const n = t.name.x;
    const allowed = SIZE_RULES[cat];
    if (!allowed.includes(sz.kind)) {
      let msg;
      if (allowed.length === 0) msg = `Type '${n}' does not take a size`;
      else if (allowed.length === 1 && allowed[0] === "range")
        msg = `Numeric type '${n}' accepts only a range (A..B), not a single value`;
      else if (allowed.length === 1) msg = `Type '${n}' takes a single size (N), not a range`;
      else msg = `Invalid size for '${n}'`;
      return err(sz.s, sz.e, msg);
    }
    const lim = intLimits(n);
    const checkBound = (b) => {
      if (b.t !== "number") return null; // constant: not resolved
      const f = isFloatLit(b.x);
      if (cat === "int" && f) { err(b.s, b.e, `'${n}' bounds must be integers`); return null; }
      if ((cat === "text" || cat === "array" || cat === "flags") && f) {
        err(b.s, b.e, "Size must be an integer"); return null;
      }
      const v = numVal(b.x);
      if (lim && (cmp(v, lim.min) < 0 || cmp(v, lim.max) > 0)) {
        err(b.s, b.e, `${b.x} is out of range for ${n} (${lim.min}..${lim.max})`);
        return null;
      }
      if ((cat === "text" || cat === "array" || cat === "flags") && cmp(v, 0) < 0) {
        err(b.s, b.e, "Size cannot be negative"); return null;
      }
      return v;
    };
    if (sz.kind === "range") {
      const a = checkBound(sz.lo), b = checkBound(sz.hi);
      if (a !== null && b !== null && cmp(a, b) > 0)
        err(sz.s, sz.e, "Range start must not be greater than its end");
    } else {
      const v = checkBound(sz.tok);
      if (v !== null && cmp(v, 0) === 0) err(sz.tok.s, sz.tok.e, "Size must be greater than 0", WARNING);
    }
  }

  for (const t of typeChecks) {
    const n = t.name.x;
    const cat = categoryOf(n);
    if (cat !== "user") {
      const want = TYPE_ARITY[n] || 0;
      if (t.args.length !== want) {
        err(t.name.s, t.name.e, want === 0
          ? `Type '${n}' does not take type arguments`
          : `Type '${n}' expects ${want} type argument(s), found ${t.args.length}`);
      }
    } else if (!declared.has(n)) {
      err(t.name.s, t.name.e, `Unknown type '${n}'`, WARNING);
    }
    if (t.size) checkSize(t, cat);
  }

  // ---- semantic checks: !define values --------------------------------------
  const seenDefs = new Map();
  function checkValue(t, v) {
    const n = t.name.x;
    const cat = categoryOf(n);
    if (v.kind === "tok" && ["const","expr"].includes(v.tok.t)) return; // reference to another constant
    const strLen = (tok) => tok.x.slice(1, -1).replace(/\\./g, "x").length;
    const inSize = (len, what) => {
      const sz = t.size;
      if (!sz) return;
      if (sz.kind === "n" && sz.tok.t === "number" && !isFloatLit(sz.tok.x) && BigInt(len) !== numVal(sz.tok.x))
        err(v.s, v.e, `${what} must be exactly ${sz.tok.x}, found ${len}`);
      if (sz.kind === "range" && sz.lo.t === "number" && sz.hi.t === "number") {
        if (cmp(len, numVal(sz.lo.x)) < 0 || cmp(len, numVal(sz.hi.x)) > 0)
          err(v.s, v.e, `${what} must be within ${sz.lo.x}..${sz.hi.x}, found ${len}`);
      }
    };
    switch (cat) {
      case "int":
      case "float": {
        if (v.kind !== "tok" || v.tok.t !== "number") return err(v.s, v.e, `Expected a number for type '${n}'`);
        if (cat === "int") {
          if (isFloatLit(v.tok.x)) return err(v.s, v.e, `Expected an integer for type '${n}'`);
          const lim = intLimits(n), x = numVal(v.tok.x);
          if (cmp(x, lim.min) < 0 || cmp(x, lim.max) > 0)
            return err(v.s, v.e, `${v.tok.x} is out of range for ${n} (${lim.min}..${lim.max})`);
        }
        const sz = t.size;
        if (sz && sz.kind === "range" && sz.lo.t === "number" && sz.hi.t === "number") {
          const x = numVal(v.tok.x);
          if (cmp(x, numVal(sz.lo.x)) < 0 || cmp(x, numVal(sz.hi.x)) > 0)
            err(v.s, v.e, `Value must be within ${sz.lo.x}..${sz.hi.x}`);
        }
        return;
      }
      case "text":
        if (n === "bytes") return;
        if (v.kind !== "tok" || v.tok.t !== "string") return err(v.s, v.e, `Expected a string for type '${n}'`);
        return inSize(strLen(v.tok), "String length");
      case "scalar":
        if (n === "bool") {
          if (v.kind !== "tok" || v.tok.t !== "ident" || !/^(true|false)$/.test(v.tok.x))
            err(v.s, v.e, "Expected 'true' or 'false' for type 'bool'");
        } else if (v.kind !== "tok" || v.tok.t !== "string") err(v.s, v.e, "Expected a character literal for type 'char'");
        return;
      case "flags":
        if (v.kind !== "tok" || v.tok.t !== "number" || isFloatLit(v.tok.x))
          return err(v.s, v.e, "Expected an integer for type 'flags'");
        if (t.size && t.size.kind === "n" && t.size.tok.t === "number") {
          const bits = numVal(t.size.tok.x), x = numVal(v.tok.x);
          if (typeof bits === "bigint" && bits < 4096n && (x < 0n || x >= (1n << bits)))
            err(v.s, v.e, `${v.tok.x} does not fit in ${bits} bits`);
        }
        return;
      case "array":
        if (v.kind !== "array") return err(v.s, v.e, "Expected an array literal [..]");
        inSize(v.items.length, "Array length");
        if (t.args[0]) for (const it of v.items) checkValue(t.args[0], it);
        return;
      default:
        return;
    }
  }
  for (const d of defs) {
    if (seenDefs.has(d.name.x)) err(d.name.s, d.name.e, `Duplicate constant '${d.name.x}'`);
    else seenDefs.set(d.name.x, d);
    checkValue(d.type, d.value);
  }

  // ---- constants must be defined --------------------------------------------
  const known = opts.known === undefined ? null : opts.known;
  if (kind === "deq" || known) {
    const names = new Set(known || []);
    for (const d of defs) names.add(d.name.x);
    for (const t of toks) {
      if (t.t === "const" && !names.has(t.x.slice(1))) {
        const nm = t.x.slice(1);
        err(t.s, t.e, `Undefined constant '${t.x}'. Add "!define ${nm}: T = VALUE;" to a .deq file`, WARNING);
      }
    }
  }
  const result=layout.analyzeLayout(structs,configs);
  return { diags:[...diags,...result.diags], defines: defs, structs, configs,plans:result.plans };
}


function offsetPosition(text,offset){const prior=text.slice(0,offset),last=prior.lastIndexOf("\n");return {line:(prior.match(/\n/g)||[]).length,character:offset-last-1};}
function positionOffset(text,p){const lines=text.split("\n");let offset=0;for(let i=0;i<Math.min(p.line,lines.length);i++)offset+=lines[i].length+1;return offset+p.character;}
const analyzerCapabilities=new Map();
function editorAnalysis(text,uri,opts={}) {
  const report=analyze(text,opts);
  const searchRoots=new Set(roots);try{let dir=path.dirname(fileURLToPath(uri));for(let i=0;i<6;i++){searchRoots.add(dir);const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}}catch{}
  const executables=[opts.analyzerPath,process.env.QSL_ANALYZER,...[...searchRoots].flatMap(r=>[path.join(r,"qsl","target","release","qsl-analyze.exe"),path.join(r,"qsl","target","release","qsl-analyze"),path.join(r,"target","release","qsl-analyze.exe"),path.join(r,"target","release","qsl-analyze")])].filter(Boolean);
  const command=executables.find(f=>fs.existsSync(f));report.analyzer=command||null;if(!command)return report;
  if(opts.kind!=="deq"){
    const modified=fs.statSync(command).mtimeMs;let cached=analyzerCapabilities.get(command);
    if(!cached||cached.modified!==modified){let capabilities={};try{const r=spawnSync(command,["--capabilities"],{input:"",encoding:"utf8",timeout:3000,windowsHide:true});capabilities=JSON.parse(r.stdout);}catch{}cached={modified,capabilities};analyzerCapabilities.set(command,cached);}
    report.nativeCapabilities=cached.capabilities;
    if(cached.capabilities.editorBundle!==1||cached.capabilities.wireLayout!==1||cached.capabilities.qpsCodecRevision!==2||cached.capabilities.qpsByteCodecRevision!==3){const s=report.structs[0]?.name;report.diags.push({s:s?.s||0,e:s?.e||0,m:"Rebuild qsl-analyze with the matching QSL version and --features rust-macros; this binary does not support the source-bundle protocol",sev:2});return report;}
  }
  const deqs=[];
  const open=new Map();for(const [u,t] of opts.openDocs||[]){try{if(u.toLowerCase().endsWith(".deq"))open.set(path.resolve(fileURLToPath(u)).toLowerCase(),t);}catch{}}
  try {let dir=path.dirname(fileURLToPath(uri)),base=path.basename(fileURLToPath(uri),".qsl")+".deq";
    outer:for(let depth=0;depth<3;depth++){for(const f of [path.join(dir,base),path.join(dir,"schema.deq")]){const edit=open.get(path.resolve(f).toLowerCase());if(edit!==undefined){deqs.push("--deq-text",edit);break outer;}if(fs.existsSync(f)){deqs.push(f);break outer;}}dir=path.dirname(dir);}
  }catch{}
  // Rust declarations are read by Syn in the native bridge. Never interpret a
  // QSL [macro] flag or attempt Rust field expansion with a JS regex parser.
  const macroSources=new Map();
  for(const [u,t] of opts.openDocs||[]){if(u.toLowerCase().endsWith(".rs"))macroSources.set(u,t);}
  try{const dir=path.dirname(fileURLToPath(uri));let total=0,count=0;
    const directories=new Set([dir,path.join(dir,"src"),path.join(path.dirname(dir),"src")]);
    for(const folder of directories){if(!fs.existsSync(folder))continue;for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(++count>256)break;if(entry.isFile()&&entry.name.endsWith(".rs")){const f=path.join(folder,entry.name),size=fs.statSync(f).size;if(size>1024*1024||total+size>4*1024*1024)continue;total+=size;const u=require("url").pathToFileURL(f).href;if(!macroSources.has(u))macroSources.set(u,fs.readFileSync(f,"utf8"));}}}
  }catch{}
  report.rustSources=macroSources;
  const rust=[...macroSources.values()].filter(t=>t.length<=1024*1024&&/#\s*\[\s*(?:\w+::)*(?:qsl_macro|schem_macro)\b/.test(t));
  const chunks=[],word=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},add=s=>{const b=Buffer.from(s);chunks.push(word(b.length),b);};add(text);chunks.push(word(rust.length));for(const r of rust)add(r);
  let result;try{result=spawnSync(command,opts.kind==="deq"?["--deq-stdin"]:["--editor-bundle",...(opts.generate?["--generate"]:[]),...deqs],{input:opts.kind==="deq"?text:Buffer.concat(chunks),encoding:"utf8",timeout:3000,maxBuffer:8*1024*1024,windowsHide:true});}catch(error){report.diags.push({s:0,e:1,sev:2,m:`Native analyzer failed: ${error.message}`});return report;}
  if(result.status!==0){report.diags.push({s:0,e:1,sev:2,m:`Native analyzer failed: ${result.error?.message||result.stderr?.trim()||result.status}`});return report;}
  try{const native=JSON.parse(result.stdout);if(native.ok){report.plans=native.schemas||[];report.generated=native.generated;report.rustMacros=native.rustMacros||[];report.diags=report.diags.filter(d=>!(native.rustMacros||[]).some(n=>d.m===`Unknown type '${n}'`));}
    else{const byte=native.offset||Number(/at byte (\d+)/.exec(native.message)?.[1])||0,at=Buffer.from(text).subarray(0,byte).toString("utf8").length;
      report.plans=[];report.diags.push({s:Math.min(Math.max(0,at-1),Math.max(0,text.length-1)),e:Math.min(Math.max(1,at),text.length),m:native.message,sev:1});}
  }catch(error){report.diags.push({s:0,e:1,sev:2,m:`Native analyzer returned invalid JSON: ${error.message}`});}
  for(const st of report.structs){const p=report.plans.find(p=>p.name===st.name.x);if(p?.qps&&!p.payloadQuantActive&&st.fields.size===1){const f=[...st.fields.values()][0];if(f.type.name.x==='u8'&&!report.diags.some(d=>d.s===f.name.s&&d.e===f.name.e&&d.m.startsWith('A single u8')))report.diags.push({s:f.name.s,e:f.name.e,sev:2,m:"A single u8 cannot benefit from grouping; exact QPS keeps raw data when framing costs more"});}}
  return report;
}

// ---- workspace .deq discovery ----------------------------------------------
let roots = process.env.QSL_WORKTREE_ROOT?[process.env.QSL_WORKTREE_ROOT]:[];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out"]);
const norm = (f) => (process.platform === "win32" ? path.resolve(f).toLowerCase() : path.resolve(f));
let fileList = { list: [], t: 0 };
const defCache = new Map();

function findDeq(dir, depth, out) {
  if (depth > 8 || out.length > 300) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) findDeq(f, depth + 1, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".deq")) out.push(f);
  }
}

function workspaceDefines(openDocs) {
  if (!roots.length) return null;
  const now = Date.now();
  if (now - fileList.t > 3000) {
    const list = [];
    for (const r of roots) findDeq(r, 0, list);
    fileList = { list, t: now };
  }
  const names = new Set();
  const open = new Map();
  for (const [uri, text] of openDocs) {
    if (!uri.toLowerCase().endsWith(".deq")) continue;
    try { open.set(norm(fileURLToPath(uri)), text); } catch { /* ignore */ }
  }
  const add = (text) => analyze(text, { kind: "deq" }).defines.forEach((d) => names.add(d.name.x));
  const listed = new Set();
  for (const f of fileList.list) {
    const key = norm(f);
    listed.add(key);
    if (open.has(key)) { add(open.get(key)); continue; }
    try {
      const st = fs.statSync(f);
      const c = defCache.get(key);
      if (c && c.m === st.mtimeMs) { c.names.forEach((n) => names.add(n)); continue; }
      const ns = analyze(fs.readFileSync(f, "utf8"), { kind: "deq" }).defines.map((d) => d.name.x);
      defCache.set(key, { m: st.mtimeMs, names: ns });
      ns.forEach((n) => names.add(n));
    } catch { /* unreadable */ }
  }
  for (const [key, text] of open) if (!listed.has(key)) add(text);
  return names;
}

// ---- LSP plumbing ------------------------------------------------------------
function toLsp(text, diags) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const pos = (o) => {
    o = Math.max(0, Math.min(o, text.length));
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return { line: lo, character: o - starts[lo] };
  };
  return diags.map((d) => ({
    range: { start: pos(d.s), end: pos(d.e) },
    severity: d.sev,
    source: "qsl",
    message: d.m,
  }));
}

function main() {
 const docs=new Map(),versions=new Map(),cache=new Map(),pending=new Map();let options={},language="en",clientLocale="",clientCaps={},seq=0,epoch=0,queue=Promise.resolve();
 const send=msg=>{const body=JSON.stringify({jsonrpc:"2.0",...msg});process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);};
 const reply=(id,result)=>send({id,result});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=`qsl-${++seq}`,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}: timeout`));},5000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});send({id,method,params});});
 const isDeq=uri=>uri.toLowerCase().endsWith(".deq");
 const configure=value=>{options={...options,...(value||{})};language=i18n.select(options,clientLocale);epoch++;cache.clear();};
 const analyzeDoc=(uri,generate=false)=>{
  const text=docs.get(uri);if(text===undefined)return null;const key=`${epoch}:${versions.get(uri)||0}`;
  if(!generate&&cache.get(uri)?.key===key)return cache.get(uri).report;
  const report=editorAnalysis(text,uri,{kind:isDeq(uri)?"deq":"qsl",known:workspaceDefines(docs),openDocs:docs,analyzerPath:options.analyzerPath,generate});
  // Incorrect partial declarations must not acquire authoritative layout hints.
  report.plans=report.plans.filter(p=>{const st=report.structs.find(s=>s.name.x===p.name);return st&&!report.diags.some(d=>d.sev===1&&d.s>=st.start&&d.s<st.end);});
  if(!generate)cache.set(uri,{key,report});return report;
 };
 const publish=uri=>{
  const text=docs.get(uri);let diagnostics=[];
  if(text!==undefined){try{const report=analyzeDoc(uri);diagnostics=toLsp(text,report.diags.map(d=>({...d,m:i18n.diagnostic(d.m,language)})));
   diagnostics.forEach((d,i)=>{d.code=report.diags[i].sev===1?"QSL_ERROR":"QSL_WARNING";d.data={originalMessage:report.diags[i].m,version:versions.get(uri)};});
  }catch(error){process.stderr.write(`[qsl-lsp] ${error.stack}\n`);diagnostics=toLsp(text,[{s:0,e:Math.min(text.length,1),sev:1,m:i18n.t(language,"analysisError",{error:error.message})}]);}}
  send({method:"textDocument/publishDiagnostics",params:{uri,version:versions.get(uri),diagnostics}});
 };
 const refresh=()=>{epoch++;cache.clear();for(const uri of docs.keys())publish(uri);for(const [cap,method]of [[clientCaps.workspace?.inlayHint?.refreshSupport,"workspace/inlayHint/refresh"],[clientCaps.workspace?.codeLens?.refreshSupport,"workspace/codeLens/refresh"]])if(cap)request(method).catch(e=>process.stderr.write(`[qsl-lsp] ${e.message}\n`));};
 const pos=(text,at)=>offsetPosition(text,at);
 const range=(text,a,b)=>({start:pos(text,a),end:pos(text,b)});
 const selected=(report,text,position)=>{const at=positionOffset(text,position);return report.structs.find(s=>s.start<=at&&at<=s.end);};
 const diagnosticFailure=(m,error)=>{process.stderr.write(`[qsl-lsp] ${m.method}: ${error.stack||error}\n`);if(m.id!==undefined)send({id:m.id,error:{code:-32603,message:i18n.t(language,"analysisError",{error:error.message||String(error)})}});else if(m.params?.textDocument?.uri){const uri=m.params.textDocument.uri,text=docs.get(uri)||"";send({method:"textDocument/publishDiagnostics",params:{uri,diagnostics:toLsp(text,[{s:0,e:Math.min(1,text.length),sev:1,m:i18n.t(language,"analysisError",{error:error.message})}])}});}};
 async function handle(m){
  const params=m.params||{};
  if(m.method==="initialize"){
   clientLocale=params.locale||"";clientCaps=params.capabilities||{};configure(params.initializationOptions||{});
   const folders=(params.workspaceFolders||[]).map(f=>f.uri);if(!folders.length&&params.rootUri)folders.push(params.rootUri);
   if(folders.length){roots=[];for(const u of folders)try{roots.push(fileURLToPath(u));}catch{}}
   return reply(m.id,{capabilities:{positionEncoding:"utf-16",textDocumentSync:{openClose:true,change:1,save:{includeText:false}},hoverProvider:true,codeActionProvider:true,inlayHintProvider:{resolveProvider:false},codeLensProvider:{resolveProvider:true},documentSymbolProvider:true,definitionProvider:true,completionProvider:{triggerCharacters:["[",",","=","|","!"],resolveProvider:false},foldingRangeProvider:true,executeCommandProvider:{commands:["qsl.inspectLayout","qsl.inspectEvents","qsl.expandRust","qsl.setLanguage"]},workspace:{workspaceFolders:{supported:true,changeNotifications:true}}},serverInfo:{name:"qsl-lsp",version:"0.6.0"}});
  }
  if(m.method==="initialized"){
   if(clientCaps.workspace?.didChangeWatchedFiles?.dynamicRegistration)request("client/registerCapability",{registrations:[{id:"qsl-inputs",method:"workspace/didChangeWatchedFiles",registerOptions:{watchers:[{globPattern:"**/*.deq"},{globPattern:"**/*.rs"},{globPattern:"**/*.qsl"}]}}]}).catch(e=>process.stderr.write(`[qsl-lsp] ${e.message}\n`));return;
  }
  if(m.method==="workspace/didChangeConfiguration"){const value=params.settings||{};configure(value["qsl-lsp"]||value.qsl||value);refresh();return;}
  if(m.method==="workspace/didChangeWatchedFiles"){fileList.t=0;defCache.clear();refresh();return;}
  if(m.method==="workspace/didChangeWorkspaceFolders"){const removed=new Set((params.event?.removed||[]).map(f=>{try{return fileURLToPath(f.uri);}catch{return "";}}));roots=roots.filter(r=>!removed.has(r));for(const f of params.event?.added||[])try{roots.push(fileURLToPath(f.uri));}catch{}fileList.t=0;refresh();return;}
  if(m.method==="textDocument/didOpen"){const d=params.textDocument;docs.set(d.uri,d.text);versions.set(d.uri,d.version||0);cache.delete(d.uri);if(isDeq(d.uri))refresh();else publish(d.uri);return;}
  if(m.method==="textDocument/didChange"){
   const uri=params.textDocument.uri;let text=docs.get(uri)||"";
   for(const change of params.contentChanges||[]){if(change.range){const start=positionOffset(text,change.range.start),end=positionOffset(text,change.range.end);text=text.slice(0,start)+change.text+text.slice(end);}else text=change.text;}
   docs.set(uri,text);versions.set(uri,params.textDocument.version??((versions.get(uri)||0)+1));cache.delete(uri);if(isDeq(uri))refresh();else publish(uri);return;
  }
  if(m.method==="textDocument/didSave"){if(params.text!==undefined)docs.set(params.textDocument.uri,params.text);refresh();return;}
  if(m.method==="textDocument/didClose"){const uri=params.textDocument.uri;docs.delete(uri);versions.delete(uri);cache.delete(uri);send({method:"textDocument/publishDiagnostics",params:{uri,diagnostics:[]}});if(isDeq(uri))refresh();return;}
  if(m.method==="shutdown")return reply(m.id,null);if(m.method==="exit")return process.exit(0);
  if(m.method==="workspace/executeCommand"){
   if(params.command==="qsl.setLanguage"){configure({language:params.arguments?.[0]?.language||"auto"});refresh();return reply(m.id,null);}
   const arg=params.arguments?.[0]||{},text=docs.get(arg.uri),report=text===undefined?null:analyzeDoc(arg.uri,params.command==="qsl.expandRust"),st=report?.structs.find(s=>s.name.x===arg.schema),p=report?.plans.find(p=>p.name===arg.schema);
   if(!p||!st)throw new Error(i18n.t(language,"invalid"));
   if(!clientCaps.window?.showDocument?.support)throw new Error(i18n.t(language,"noShowDocument"));
   if(!["qsl.inspectLayout","qsl.inspectEvents","qsl.expandRust"].includes(params.command))throw new Error("Unknown command");
   const rust=params.command==="qsl.expandRust",content=rust?report.generated:ui.inspect(st,p,language,params.command==="qsl.inspectEvents");if(!content)throw new Error(i18n.t(language,"generateError"));
   const directory=process.env.QSL_ANALYSIS_DIR||path.join(__dirname,".analysis");fs.mkdirSync(directory,{recursive:true});const hash=require("crypto").createHash("sha256").update(arg.uri).digest("hex").slice(0,12),file=path.join(directory,`${hash}-${p.name}-${rust?"generated.rs":params.command==="qsl.inspectEvents"?"events.md":"layout.md"}`);fs.writeFileSync(file,content);
   const uri=require("url").pathToFileURL(file).href;const shown=await request("window/showDocument",{uri,takeFocus:true,external:false});if(!shown?.success)throw new Error(i18n.t(language,"noShowDocument"));return reply(m.id,{uri});
  }
  if(m.method==="codeLens/resolve")return reply(m.id,params);
  const uri=params.textDocument?.uri,text=docs.get(uri);if(text===undefined){if(m.id!==undefined)return reply(m.id,["textDocument/hover","textDocument/definition"].includes(m.method)?null:[]);return;}
  const report=analyzeDoc(uri);
  if(m.method==="textDocument/hover"){
   const st=selected(report,text,params.position),p=st&&report.plans.find(p=>p.name===st.name.x),at=positionOffset(text,params.position),f=st&&[...st.fields.values()].find(f=>f.start<=at&&at<=f.end);
   return reply(m.id,p?{contents:{kind:"markdown",value:f?ui.fieldHover(st,p,f.name.x,language)||ui.schemaHover(st,p,language):ui.schemaHover(st,p,language)},range:f?range(text,f.name.s,f.name.e):range(text,st.name.s,st.name.e)}:null);
  }
  if(m.method==="textDocument/inlayHint"){const hints=ui.hints(report,text,language,options.inlayHints||{},at=>pos(text,at));return reply(m.id,params.range?hints.filter(h=>positionOffset(text,h.position)>=positionOffset(text,params.range.start)&&positionOffset(text,h.position)<=positionOffset(text,params.range.end)):hints);}
  if(m.method==="textDocument/codeLens"){const lenses=[];if(options.codeLens!==false)for(const st of report.structs){const p=report.plans.find(p=>p.name===st.name.x);if(!p)continue;const entry=(command,title)=>lenses.push({range:range(text,st.name.s,st.name.e),command:{command,title,arguments:[{uri,schema:p.name}]}});entry("qsl.inspectLayout",`${ui.frameSize(st,p,language)} · ${i18n.t(language,"layout")}`);if(p.lengthGraph)entry("qsl.inspectEvents",`${p.lengthGraph.events.length} · ${i18n.t(language,"events")}`);if(report.analyzer&&!p.approximate)entry("qsl.expandRust",i18n.t(language,"generated"));}return reply(m.id,lenses);}
  if(m.method==="textDocument/documentSymbol")return reply(m.id,[...report.structs.map(st=>({name:st.name.x,kind:23,range:range(text,st.start,st.end),selectionRange:range(text,st.name.s,st.name.e),children:[...st.fields.values()].map(f=>({name:f.name.x,detail:`${f.type.name.x}${f.type.optional?"?":""}`,kind:8,range:range(text,f.start,f.end),selectionRange:range(text,f.name.s,f.name.e)}))})),...report.defines.map(d=>({name:d.name.x,kind:14,range:range(text,d.name.s,d.value.e),selectionRange:range(text,d.name.s,d.name.e)}))]);
  if(m.method==="textDocument/foldingRange")return reply(m.id,report.structs.map(st=>({startLine:pos(text,st.start).line,endLine:pos(text,st.end).line,kind:"region"})).filter(r=>r.endLine>r.startLine));
  if(m.method==="textDocument/completion")return reply(m.id,ui.completions(report,text,positionOffset(text,params.position),language));
  if(m.method==="textDocument/definition"){
   const at=positionOffset(text,params.position),token=[...text.matchAll(/!?[A-Za-z_][A-Za-z0-9_]*/g)].find(m=>m.index<=at&&at<=m.index+m[0].length)?.[0],out=[];
   if(token){const sources=new Map(docs);for(const f of fileList.list)try{const u=require("url").pathToFileURL(f).href;if(!sources.has(u)&&fs.statSync(f).size<=1024*1024)sources.set(u,fs.readFileSync(f,"utf8"));}catch{}
    for(const [u,source]of sources){const other=analyze(source,{kind:isDeq(u)?"deq":"qsl"});for(const target of token.startsWith("!")?other.defines:other.structs)if(target.name.x===token.replace(/^!/,""))out.push({uri:u,range:range(source,target.name.s,target.name.e)});}
    if(!token.startsWith("!")&&(report.rustMacros||[]).includes(token))for(const [u,source]of report.rustSources||[]){const re=new RegExp("\\bstruct\\s+("+token+")\\b","g");for(const match of source.matchAll(re)){const start=match.index+match[0].lastIndexOf(token);out.push({uri:u,range:range(source,start,start+token.length)});}}
   }return reply(m.id,out);
  }
  if(m.method==="textDocument/codeAction"){
   const actions=[];for(const st of report.structs){if(params.range&&(positionOffset(text,params.range.end)<st.start||positionOffset(text,params.range.start)>st.end))continue;
    const fields=[...st.fields.values()],first=fields.find(f=>f.type.optional);
    if(first)for(const f of fields.filter(f=>!f.type.optional&&f.start>first.start))actions.push({title:i18n.t(language,"move",{name:f.name.x}),kind:"quickfix",edit:{changes:{[uri]:[{range:range(text,f.start,f.end),newText:""},{range:range(text,first.start,first.start),newText:text.slice(f.start,f.end)+"\n    "}]}}});
    const p=report.plans.find(p=>p.name===st.name.x);
    if(p?.suggestFixedPrefix){const variable=f=>{const row=ui.wire(st,p).fields.find(r=>r.name===f.name.x);return !row||row.minBits===null||row.maxBits===null||row.minBits!==row.maxBits;},required=fields.filter(f=>!f.type.optional),reordered=[...required.filter(f=>!variable(f)),...required.filter(variable),...fields.filter(f=>f.type.optional)];
      if(fields.length&&reordered.some((f,i)=>f!==fields[i])&&!fields.slice(1).some((f,i)=>text.slice(fields[i].end,f.start).trim()))actions.push({title:i18n.t(language,"fixedFirst"),kind:"refactor.rewrite",edit:{changes:{[uri]:[{range:range(text,fields[0].start,fields.at(-1).end),newText:reordered.map(f=>text.slice(f.start,f.end)).join("\n    ")}]}}});}
    if(p){for(const [command,key]of [["qsl.inspectLayout","layout"],...(p.lengthGraph?[["qsl.inspectEvents","eventAction"]]:[]),...(report.analyzer&&!p.approximate?[["qsl.expandRust","generated"]]:[])])actions.push({title:i18n.t(language,key),kind:"refactor.rewrite",command:{command,title:i18n.t(language,key),arguments:[{uri,schema:p.name}]}});}
   }if(report.plans.length)actions.push({title:i18n.t(language,language==="ru"?"switchEn":"switchRu"),kind:"source",command:{command:"qsl.setLanguage",title:"QSL language",arguments:[{language:language==="ru"?"en":"ru"}]}});return reply(m.id,actions);
  }
  if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:"Method not found"}});
 }
 let buf=Buffer.alloc(0);
 process.stdin.on("data",chunk=>{buf=Buffer.concat([buf,chunk]);for(;;){const end=buf.indexOf("\r\n\r\n");if(end<0)return;const match=/Content-Length: *(\d+)/i.exec(buf.subarray(0,end).toString("ascii"));if(!match){buf=buf.subarray(end+4);continue;}const length=Number(match[1]);if(!Number.isSafeInteger(length)||length>16*1024*1024){process.stderr.write("[qsl-lsp] Oversized LSP message\n");process.exit(1);}const total=end+4+length;if(buf.length<total)return;const body=buf.subarray(end+4,total).toString("utf8");buf=buf.subarray(total);let m;try{m=JSON.parse(body);}catch(error){process.stderr.write(`[qsl-lsp] Invalid JSON: ${error.message}\n`);continue;}
  if(!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);continue;}
  queue=queue.then(()=>handle(m)).catch(error=>diagnosticFailure(m,error));
 }});
}
if(require.main===module)main();
else module.exports={analyze,editorAnalysis};
