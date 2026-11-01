"use strict";
// Advisory fallback shares the bounded DIRECT_BITS/unit-transition model with
// QSL. When qsl-analyze is available its parser/build plan is authoritative.
function analyzeLayout(structs, configs = {}) {
  const plans = [], diags = [];
  const definitions=new Map(structs.map(s=>[s.name.x,s]));
  const cache=new Map();
  const expand=(s,trail=[])=>{
    if(cache.has(s.name.x))return cache.get(s.name.x);
    if(trail.includes(s.name.x)||trail.length>=64){diags.push({s:s.name.s,e:s.name.e,m:`Cyclic or excessive macro nesting: ${[...trail,s.name.x].join(" -> ")}`,sev:1});return {...s,fields:new Map()};}
    const fields=new Map();let height=1;
    for(const f of s.fields.values()){
      const target=definitions.get(f.type.name.x);
      if(target&&Object.hasOwn(target.attrs,"macro")){
        if(f.type.optional||Object.hasOwn(f.modifiers,"default")){diags.push({s:f.name.s,e:f.name.e,m:"A macro reference cannot have group optionality/default; annotate its fields",sev:1});continue;}
        const expanded=expand(target,[...trail,s.name.x]);height=Math.max(height,1+(expanded.macroDepth||1));
        if(height>64){diags.push({s:f.name.s,e:f.name.e,m:"Structure-macro nesting exceeds 64",sev:1});break;}
        for(const child of expanded.fields.values()){
          const name={...f.name,x:`${f.name.x}_${child.name.x}`};
          if(fields.has(name.x))diags.push({s:name.s,e:name.e,m:`Expanded field collision '${name.x}'`,sev:1});
          fields.set(name.x,{...child,name,start:f.start,end:f.end});
        }
      }else{if(fields.has(f.name.x))diags.push({s:f.name.s,e:f.name.e,m:`Expanded field collision '${f.name.x}'`,sev:1});fields.set(f.name.x,f);}
      if(fields.size>64){diags.push({s:s.name.s,e:s.name.e,m:"Expanded schema exceeds 64 fields",sev:1});break;}
    }const result={...s,fields,macroDepth:height};cache.set(s.name.x,result);return result;
  };
  for (const s of structs.map(s=>expand(s))) {
    let maximum = 0, bits = 0, variableSeen = false, suggestFixedPrefix = false;
    const fields = [...s.fields.values()], optional = fields.filter(f => f.type.optional);
    const attrs = s.attrs || {}, qps = Object.hasOwn(attrs, "qps");
    const quantum = qps ? Number((attrs.qps || "Q1").replace("Q", "")) : 1;
    const error = (token, m) => diags.push({s:token.s,e:token.e,m,sev:1});
    for (const [k,v] of Object.entries(attrs)) {
      if (!["macro","qps","predict_seq","opt_table","inline","compact","alignment","lifetime","safety","optionals"].includes(k)) error(s.name,`Unknown schema attribute '${k}'`);
      if (k === "qps" && ![1,2,4,8,16].includes(quantum)) error(s.name,"QPS quantum must be Q1, Q2, Q4, Q8 or Q16");
      if (k === "inline" && v && !["hint","always","never"].includes(v)) error(s.name,"inline expects hint, always or never");
    }
    const predictive = qps || Object.hasOwn(attrs,"predict_seq");
    const strictTail=true;
    if ((predictive || Object.hasOwn(attrs,"opt_table")) && (attrs.compact !== undefined || attrs.optionals === "bitmap")) error(s.name,"Predictive/opt_table layout cannot be combined with compact or bitmap");
    if (predictive && !optional.length) error(s.name,"Predictive layout requires an optional tail");
    if (fields.length > 64) error(s.name,"QSL supports at most 64 compiler-assigned field tags");
    let optionalSeen = false;
    const widths = [];
    for (const f of fields) {
      if (f.type.optional) optionalSeen = true;
      else if (optionalSeen&&strictTail) error(f.name,"Required fields must precede all optional fields. Move this field before the optional tail; this changes the wire format.");
      const t = f.type, n = t.name.x, sz = t.size;
      const number = tok => tok?.t === "number" && !tok.x.includes(".") ? Number(BigInt(tok.x.replaceAll("_",""))) : null;
      const lo = sz?.kind === "range" ? number(sz.lo) : sz ? number(sz.tok) : 0;
      const hi = sz?.kind === "range" ? number(sz.hi) : sz ? number(sz.tok) : null;
      let width = /^([ui])(8|16|32|64)$/.test(n) ? Number(n.slice(1))/8 : null;
      if (n === "flags" && lo !== null && lo >= 1 && lo <=64) width = lo <=8 ?1:lo<=16?2:lo<=32?4:8;
      const string = ["str","string","String"].includes(n);
      const fixedString = string && sz && (sz.kind === "n" || lo === hi);
      const compression = f.modifiers.decompress === "true";
      if (string && hi !== null) width = fixedString ? hi : hi + (compression || f.modifiers.binary_opt === "inline" ? hi<=127?1:hi<=32767?2:4 : 4);
      if(qps && t.optional && string && hi!==null && !compression)width=hi;
      if (!f.type.optional) {if (width === null) variableSeen = true; else if(variableSeen) suggestFixedPrefix = true;}
      if (width === null || !Number.isSafeInteger(width)) maximum = null;
      else if(maximum !== null) maximum += width;
      if (f.type.optional) {
        if (string && !fixedString) {
          widths.push(null);
          if (hi === null || lo === null || compression) {if(qps) error(f.name,"QPS needs finite raw UTF-8 byte bounds; keep the legacy codec for compressed/unbounded fields");}
          else bits += Math.ceil(Math.log2(hi-lo+2));
        } else {widths.push(width);bits++;if(compression&&qps)error(f.name,"QPS does not reinterpret compressed UTF-8 as raw bytes");}
      }
    }
    if (qps && bits>32) error(s.name,`DIRECT_BITS requires ${bits} bits; D has 32. Disable QPS or split the schema.`);
    let reason = "legacy codec", indexBytes = 0, plainIndexBytes = 0;
    if (predictive) {
      reason = "direct D extraction";
      if (widths.every(n=>n!==null) && widths.length <=12 && widths.reduce((a,b)=>a+b,0)<=65535) {
        const sums = new Set();let collision=false;
        for(let mask=0;mask<2**widths.length;mask++){let total=0;for(let j=0;j<widths.length;j++)if(mask&(1<<j))total+=widths[j];if(sums.has(total)){collision=true;break;}sums.add(total);}
        if(!collision){const size=widths.reduce((a,b)=>a+b,0)+1;plainIndexBytes=size*4;indexBytes=Math.ceil(size/quantum)*4;reason="exact static subset-sum lookup";}
        else reason="ambiguous subset sums: direct D is required";
      } else reason="variable lengths or table analysis budget: direct D extraction";
      if(!qps && optional.length>1 && !plainIndexBytes)error(s.name,"Non-quantized predict_seq needs unique fixed-size subset sums within the table budget; use qps or opt_table");
      if(quantum>1 && !plainIndexBytes)error(s.name,"Selected Q_table cannot reconstruct this layout from length; use unquantized qps (D) or opt_table");
    }
    if(maximum!==null){
      if(qps)maximum+=4;
      else if(Object.hasOwn(attrs,"opt_table")&&optional.length>1)maximum+=1+4*optional.length;
      else if(!Object.hasOwn(attrs,"predict_seq")&&optional.length)maximum+=Math.ceil((optional.length===1?1:Math.ceil(Math.log2(optional.length+1))+optional.length*Math.ceil(Math.log2(Math.max(1,fields.length))))/8);
    }
    plans.push({name:s.name.x,maximum,rtEligible:maximum!==null,rtEnabled:configs.QSL_RT==="true"&&maximum!==null,slots:Number(configs.QSL_RT_DEFAULT||16),qps,quantum,dBits:bits,indexBytes,plainIndexBytes,reason,inline:Object.hasOwn(attrs,"inline")?(attrs.inline||"hint"):"compiler default",optionalCount:optional.length,fieldCount:fields.length,structureMacro:Object.hasOwn(attrs,"macro"),optionalTailRequired:strictTail,safety:Object.hasOwn(attrs,"safety"),suggestFixedPrefix,approximate:true});
  }
  return {plans,diags};
}
function describe(p) {
  return [
    `**${p.name} · QSL build plan${p.approximate ? " (предварительный)" : ""}**`,
    `Максимум кадра: ${p.maximum === null ? "не ограничен статически" : `${p.maximum} B`}. Optional-полей: ${p.optionalCount}.`,
    `RT: ${p.rtEligible ? `доступен при QSL_RT=true, ${p.slots} буферов; исчерпание → PoolExhausted` : `недоступен: ${p.rtReason||"задайте конечные границы строк/массивов и размеры custom codec"}`}.`,
    p.qps ? `QPS: D занимает 4 B, использовано ${p.dBits}/32 бит. Данные и длины точные.` : "QPS выключен: сохраняется выбранный неквантованный формат.",
    p.plainIndexBytes ? `Таблица индексов Q${p.quantum}: ${p.indexBytes} B вместо ${p.plainIndexBytes} B. Это сжатие таблицы, без потери payload. Скорость определяется измерением.` : `Стратегия: ${p.reason}.`,
    `Inline: ${p.inline}.`,
    ...(p.structureMacro?[`Структура-макрос: отдельный Rust-тип сохранён; при вставке разворачиваются ${p.fieldCount} полей. Вложенные вставки разворачиваются рекурсивно.`]:[]),
    `Проверка входных данных: ${p.safety?"доступна через checked API ([safety])":"выключена; включается атрибутом [safety]"}. Порядок optional-хвоста: ${p.optionalTailRequired?"обязателен для всех схем":"свободный, прежний формат"}.`,
    ...(p.strings||[]),
    p.suggestFixedPrefix ? "Можно вынести фиксированные обязательные поля перед переменными, сохранив optional-хвост. Это изменит формат: обновите обе стороны соединения." : "Порядок полей сохраняется точно по схеме."
  ].join("\n\n");
}
module.exports={analyzeLayout,describe};
