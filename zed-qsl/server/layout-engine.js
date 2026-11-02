"use strict";
// Advisory fallback shares the bounded DIRECT_BITS/unit-transition model with
// QSL. When qsl-analyze is available its parser/build plan is authoritative.
function payloadPlan(fields,attrs,rawMaximum) {
  const result={payloadQuantRequested:Object.hasOwn(attrs,"quant"),payloadQuantActive:false,payloadQuantum:Number((attrs.quant||"Q2").replace("Q","")),payloadPadding:0,rawMaximum,payloadReason:"payload quantization disabled"};
  if(!result.payloadQuantRequested)return result;
  if(![2,4,8,16].includes(result.payloadQuantum)){result.payloadReason="quant expects Q2, Q4, Q8 or Q16";return result;}
  let bits=0,required=0,residues=new Set([0]),padding=1;
  const literal=t=>{try{return t?.t==="number"&&!t.x.includes(".")?BigInt(t.x.replaceAll("_","")):null;}catch{return null;}};
  for(const f of fields){
    const n=f.type.name.x,match=/^([ui])(8|16|32|64)$/.exec(n);
    if(!match){result.payloadReason="non-numeric or unresolved payload: raw fallback; use the native analyzer for the exact plan";return result;}
    const width=BigInt(match[2]);let lo=match[1]==="i"?-(1n<<(width-1n)):0n,hi=match[1]==="i"?(1n<<(width-1n))-1n:(1n<<width)-1n;
    if(f.type.size){lo=literal(f.type.size.lo);hi=literal(f.type.size.hi);if(lo===null||hi===null||hi<lo){result.payloadReason="bounds need native evaluation; raw advisory fallback";return result;}}
    const span=hi-lo,b=span===0n?0:span.toString(2).length;
    const start=Math.max(...residues),word=[1,2,4,8,16].find(w=>w<=result.payloadQuantum&&w*8>=b+start)||result.payloadQuantum;
    padding=Math.max(padding,word);bits+=b;if(!f.type.optional)required+=b;
    const next=new Set([...residues].map(r=>(r+b)&7));residues=f.type.optional?new Set([...residues,...next]):next;
  }
  const header=Object.hasOwn(attrs,"qps")?4:Math.ceil(fields.filter(f=>f.type.optional).length/8);
  result.payloadMaximum=header+Math.ceil(bits/8);result.payloadMinimum=header+Math.ceil(required/8);
  result.payloadQuantActive=rawMaximum!==null&&result.payloadMaximum+padding<rawMaximum;
  result.payloadPadding=result.payloadQuantActive?padding:0;
  result.payloadReason=result.payloadQuantActive?"exact quotient and remainder; separate native restoration":"no physical buffer saving including padding; raw fallback";
  return result;
}
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
      if (!["macro","qps","quant","predict_seq","opt_table","inline","compact","alignment","lifetime","safety","optionals"].includes(k)) error(s.name,`Unknown schema attribute '${k}'`);
      if (k === "qps" && ![1,2,4,8,16].includes(quantum)) error(s.name,"QPS quantum must be Q1, Q2, Q4, Q8 or Q16");
      if (k === "inline" && v && !["hint","always","never"].includes(v)) error(s.name,"inline expects hint, always or never");
      if(k==="quant"&&!["Q2","Q4","Q8","Q16"].includes(v))error(s.name,"quant expects Q2, Q4, Q8 or Q16");
      if(k==="opt_table"&&v&&!["static","legacy"].includes(v))error(s.name,"opt_table expects static or legacy");
    }
    const predictive = qps || Object.hasOwn(attrs,"predict_seq");
    const staticOptional=Object.hasOwn(attrs,"opt_table")&&attrs.opt_table!=="legacy";
    if(attrs.opt_table==="legacy"&&(qps||Object.hasOwn(attrs,"predict_seq")))error(s.name,"Legacy wire offsets conflict with predictive layouts");
    if(Object.hasOwn(attrs,"quant")&&(Object.hasOwn(attrs,"compact")||Object.hasOwn(attrs,"alignment")||attrs.optionals==="bitmap"||attrs.opt_table==="legacy"))error(s.name,"quant conflicts with compact, alignment, bitmap and legacy offsets");
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
    if (predictive||staticOptional) {
      reason = "direct D extraction";
      if (widths.every(n=>n!==null) && widths.length <=12 && widths.reduce((a,b)=>a+b,0)<=65535) {
        const sums = new Set();let collision=false;
        for(let mask=0;mask<2**widths.length;mask++){let total=0;for(let j=0;j<widths.length;j++)if(mask&(1<<j))total+=widths[j];if(sums.has(total)){collision=true;break;}sums.add(total);}
        if(!collision){const size=widths.reduce((a,b)=>a+b,0)+1;plainIndexBytes=size*4;indexBytes=Math.ceil(size/quantum)*4;reason="exact static subset-sum lookup";}
        else reason="ambiguous subset sums: direct D is required";
      } else reason="variable lengths or table analysis budget: direct D extraction";
      if(!qps && predictive && optional.length>1 && !plainIndexBytes)error(s.name,"Non-quantized predict_seq needs unique fixed-size subset sums within the table budget; use qps or opt_table");
      if(quantum>1 && !plainIndexBytes)error(s.name,"Selected Q_table cannot reconstruct this layout from length; use unquantized qps (D) or opt_table");
    }
    if(maximum!==null){
      if(qps)maximum+=4;
      else if(staticOptional)maximum+=plainIndexBytes||optional.length===0||optional.length===1&&widths[0]!==0?0:Math.ceil(optional.length/8);
      else if(attrs.opt_table==="legacy"&&optional.length>1)maximum+=1+4*optional.length;
      else if(attrs.opt_table==="legacy"&&optional.length===1){}
      else if(!Object.hasOwn(attrs,"predict_seq")&&optional.length)maximum+=Math.ceil((optional.length===1?1:Math.ceil(Math.log2(optional.length+1))+optional.length*Math.ceil(Math.log2(Math.max(1,fields.length))))/8);
    }
    const payload=payloadPlan(fields,attrs,maximum);
    if(payload.payloadQuantActive){maximum=payload.payloadMaximum;if(Object.hasOwn(attrs,"predict_seq"))error(s.name,"quant cannot infer field presence from compressed byte length; use opt_table or qps");if(qps&&quantum!==1)error(s.name,"Payload bit-prefix graphs use direct D, not Q_table length lookup; combine quant with plain qps");}
    const slots=Number(configs.QSL_RT_DEFAULT||16),eligible=maximum!==null&&(maximum+payload.payloadPadding)*slots<=64*1024*1024;
    const mode=payload.payloadQuantActive&&staticOptional?"packed bit-prefix Boolean graph":staticOptional?(plainIndexBytes?"static critical lengths; no wire directory":"static prefix graph with presence bits or EOF predicate; no wire directory"):attrs.opt_table==="legacy"?"legacy wire offset directory":"disabled";
    plans.push({name:s.name.x,maximum,rtEligible:eligible,rtEnabled:configs.QSL_RT==="true"&&eligible,slots,qps,quantum,dBits:bits,indexBytes,plainIndexBytes,reason,staticOptional:mode,...payload,inline:Object.hasOwn(attrs,"inline")?(attrs.inline||"hint"):"compiler default",optionalCount:optional.length,fieldCount:fields.length,structureMacro:Object.hasOwn(attrs,"macro"),optionalTailRequired:strictTail,safety:Object.hasOwn(attrs,"safety"),suggestFixedPrefix,approximate:true});
  }
  return {plans,diags};
}
function describe(p) {
  return [
    `**${p.name} · QSL build plan${p.approximate ? " (предварительный)" : ""}**`,
    `Максимум кадра: ${p.maximum === null ? "не ограничен статически" : `${p.maximum} B`}. Optional-полей: ${p.optionalCount}.`,
    `RT: ${p.rtEligible ? `доступен при QSL_RT=true, ${p.slots} буферов; исчерпание → PoolExhausted` : `недоступен: ${p.rtReason||"задайте конечные границы строк/массивов и размеры custom codec"}`}.`,
    p.qps ? `QPS: D занимает 4 B, использовано ${p.dBits}/32 бит. Данные и длины точные.` : "QPS выключен: формат метаданных задаёт выбранный кодек.",
    p.plainIndexBytes ? `Таблица индексов Q${p.quantum}: ${p.indexBytes} B вместо ${p.plainIndexBytes} B. Это сжатие таблицы, без потери payload. Скорость определяется измерением.` : p.payloadQuantActive?"Адресация payload: статический битовый префикс по булевым признакам присутствия.":`Стратегия: ${p.reason}.`,
    `Inline: ${p.inline}.`,
    ...(p.staticOptional&&p.staticOptional!=="disabled"?[`opt_table: ${p.staticOptional}.`]:[]),
    ...(p.payloadQuantRequested?[p.payloadQuantActive?`Payload quant=Q${p.payloadQuantum}: максимум ${p.payloadMaximum} B вместо ${p.rawMaximum} B; отдельно ${p.payloadPadding} B инициализированного хвоста (не передаётся). Частное и остаток сохранены полностью. Восстановление идёт в отдельный нативный буфер; подготовленные области используются повторно.`:`Payload: raw fallback. ${p.payloadReason}.`]:[]),
    ...(p.structureMacro?[`Структура-макрос: отдельный Rust-тип сохранён; при вставке разворачиваются ${p.fieldCount} полей. Вложенные вставки разворачиваются рекурсивно.`]:[]),
    `Проверка входных данных: ${p.safety?"доступна через checked API ([safety])":"выключена; включается атрибутом [safety]"}. Порядок optional-хвоста: ${p.optionalTailRequired?"обязателен для всех схем":"свободный, прежний формат"}.`,
    ...(p.strings||[]),
    p.suggestFixedPrefix ? "Можно вынести фиксированные обязательные поля перед переменными, сохранив optional-хвост. Это изменит формат: обновите обе стороны соединения." : "Порядок полей сохраняется точно по схеме."
  ].join("\n\n");
}
module.exports={analyzeLayout,describe};
