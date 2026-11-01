#!/usr/bin/env node
// QSL language server (stdio, no dependencies). Diagnostics for .qsl and .deq files.
"use strict";
const fs = require("fs");
const {spawnSync}=require("child_process");
const layout=require("./layout-engine");
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
function editorAnalysis(text,uri,opts={}) {
  const report=analyze(text,opts);
  const executables=[process.env.QSL_ANALYZER,...roots.flatMap(r=>[path.join(r,"qsl","target","release","qsl-analyze.exe"),path.join(r,"qsl","target","release","qsl-analyze")])].filter(Boolean);
  const command=executables.find(f=>fs.existsSync(f));if(!command)return report;
  const deqs=[];
  const open=new Map();for(const [u,t] of opts.openDocs||[]){try{if(u.toLowerCase().endsWith(".deq"))open.set(path.resolve(fileURLToPath(u)).toLowerCase(),t);}catch{}}
  try {let dir=path.dirname(fileURLToPath(uri)),base=path.basename(fileURLToPath(uri),".qsl")+".deq";
    outer:for(let depth=0;depth<3;depth++){for(const f of [path.join(dir,base),path.join(dir,"schema.deq")]){const edit=open.get(path.resolve(f).toLowerCase());if(edit!==undefined){deqs.push("--deq-text",edit);break outer;}if(fs.existsSync(f)){deqs.push(f);break outer;}}dir=path.dirname(dir);}
  }catch{}
  // Neighboring/open QSL macro declarations are supplied to the same native
  // expander. Custom build.rs input scopes remain explicit in project docs.
  const own=new Set(report.structs.map(s=>s.name.x)),macroSources=new Map();
  for(const [u,t] of opts.openDocs||[]){if(u!==uri&&u.toLowerCase().endsWith(".qsl"))macroSources.set(u,t);}
  try{const dir=path.dirname(fileURLToPath(uri));let total=0,count=0;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++count>256)break;if(entry.isFile()&&entry.name.endsWith(".qsl")){const f=path.join(dir,entry.name);const size=fs.statSync(f).size;if(size>1024*1024||total+size>4*1024*1024)continue;total+=size;const u=require("url").pathToFileURL(f).href;if(u!==uri&&!macroSources.has(u))macroSources.set(u,fs.readFileSync(f,"utf8"));}}
  }catch{}
  for(const content of macroSources.values()){if(content.length>1024*1024)continue;for(const st of analyze(content).structs){if(Object.hasOwn(st.attrs,"macro")&&!own.has(st.name.x)){own.add(st.name.x);deqs.push("--macro-text",content.slice(st.start,st.end));}}}
  let result;try{result=spawnSync(command,opts.kind==="deq"?["--deq-stdin"]:deqs,{input:text,encoding:"utf8",timeout:3000,maxBuffer:1024*1024,windowsHide:true});}catch{return report;}
  if(result.status!==0)return report;
  try{const native=JSON.parse(result.stdout);if(native.ok){report.plans=native.schemas||[];report.diags=report.diags.filter(d=>d.sev!==1&&!report.plans.some(p=>p.structureMacro&&d.m===`Unknown type '${p.name}'`));}
    else{const at=Buffer.from(text).subarray(0,native.offset||0).toString("utf8").length;report.diags=report.diags.filter(d=>d.sev===1);report.diags.push({s:Math.max(0,at-1),e:at,m:native.message,sev:1});}
  }catch{}return report;
}

// ---- workspace .deq discovery ----------------------------------------------
let roots = [];
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
  const docs = new Map();
  const send = (msg) => {
    const s = JSON.stringify({ jsonrpc: "2.0", ...msg });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  const isDeq = (uri) => uri.toLowerCase().endsWith(".deq");
  const publish = (uri) => {
    const text = docs.get(uri);
    let diagnostics = [];
    if (text !== undefined) {
      const kind = isDeq(uri) ? "deq" : "qsl";
      const known = workspaceDefines(docs);
      const report=editorAnalysis(text,uri,{kind,known,openDocs:docs});
      diagnostics = toLsp(text,report.diags);
      for(const plan of report.plans){const st=report.structs.find(s=>s.name.x===plan.name);if(!st)continue;
        diagnostics.push(...toLsp(text,[{s:st.name.s,e:st.name.e,sev:3,m:`${plan.maximum===null?"Unbounded":`Max ${plan.maximum} B`}; RT ${plan.rtEligible?`eligible (${plan.slots} slots)`:"unavailable"}; ${plan.qps?`D ${plan.dBits}/32 bits; Q${plan.quantum}, index ${plan.indexBytes}/${plan.plainIndexBytes} B`:plan.reason}. Hover for build plan.`}]));}
    }
    send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  };
  const publishQslDocs = () => { for (const uri of docs.keys()) if (!isDeq(uri)) publish(uri); };

  function handle(m) {
    switch (m.method) {
      case "initialize": {
        const pr = m.params || {};
        const folders = (pr.workspaceFolders || []).map((f) => f.uri);
        if (!folders.length && pr.rootUri) folders.push(pr.rootUri);
        roots = [];
        for (const u of folders) { try { roots.push(fileURLToPath(u)); } catch { /* ignore */ } }
        return send({ id: m.id, result: {
          capabilities: { textDocumentSync: { openClose: true, change: 1 },hoverProvider:true,codeActionProvider:true },
          serverInfo: { name: "qsl-lsp", version: "0.1.0" },
        } });
      }
      case "textDocument/hover": {
        const {textDocument,position}=m.params;const text=docs.get(textDocument.uri);
        if(text===undefined)return send({id:m.id,result:null});
        const report=editorAnalysis(text,textDocument.uri,{kind:isDeq(textDocument.uri)?"deq":"qsl",known:workspaceDefines(docs),openDocs:docs});
        const at=positionOffset(text,position),st=report.structs.find(s=>s.start<=at&&at<=s.end);
        const plan=st&&report.plans.find(p=>p.name===st.name.x);
        return send({id:m.id,result:plan?{contents:{kind:"markdown",value:layout.describe(plan)}}:null});
      }
      case "textDocument/codeAction": {
        const uri=m.params.textDocument.uri,text=docs.get(uri);if(text===undefined)return send({id:m.id,result:[]});
        const report=analyze(text),actions=[];
        for(const st of report.structs){const fields=[...st.fields.values()],first=fields.find(f=>f.type.optional);if(!first)continue;
          for(const f of fields.filter(f=>!f.type.optional&&f.start>first.start))actions.push({title:`Move '${f.name.x}' before optional fields (wire format changes)`,kind:"quickfix",edit:{changes:{[uri]:[
            {range:{start:offsetPosition(text,f.start),end:offsetPosition(text,f.end)},newText:""},
            {range:{start:offsetPosition(text,first.start),end:offsetPosition(text,first.start)},newText:text.slice(f.start,f.end)+"\n    "}
          ]}}});}
        return send({id:m.id,result:actions});
      }
      case "shutdown": return send({ id: m.id, result: null });
      case "exit": return process.exit(0);
      case "textDocument/didOpen": {
        const d = m.params.textDocument;
        docs.set(d.uri, d.text);
        publish(d.uri);
        if (isDeq(d.uri)) publishQslDocs();
        return;
      }
      case "textDocument/didChange": {
        const uri = m.params.textDocument.uri;
        const ch = m.params.contentChanges;
        docs.set(uri, ch[ch.length - 1].text);
        publish(uri);
        if (isDeq(uri)) publishQslDocs();
        return;
      }
      case "textDocument/didClose": {
        const uri = m.params.textDocument.uri;
        docs.delete(uri);
        send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
        if (isDeq(uri)) publishQslDocs();
        return;
      }
      default:
        if (m.id !== undefined && m.method)
          send({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const he = buf.indexOf("\r\n\r\n");
      if (he < 0) return;
      const mm = /Content-Length: *(\d+)/i.exec(buf.slice(0, he).toString("ascii"));
      if (!mm) { buf = buf.slice(he + 4); continue; }
      const total = he + 4 + Number(mm[1]);
      if (buf.length < total) return;
      const body = buf.slice(he + 4, total).toString("utf8");
      buf = buf.slice(total);
      try { handle(JSON.parse(body)); } catch (e) { /* ignore malformed */ }
    }
  });
}

if (require.main === module) main();
else module.exports = { analyze,editorAnalysis };
