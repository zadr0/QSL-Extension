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
  const header=Object.hasOwn(attrs,"state_bits")?4:Math.ceil(fields.filter(f=>f.type.optional).length/8);
  result.payloadMaximum=header+Math.ceil(bits/8);result.payloadMinimum=header+Math.ceil(required/8);
  result.payloadQuantActive=rawMaximum!==null&&result.payloadMaximum+padding<rawMaximum;
  result.payloadPadding=result.payloadQuantActive?padding:0;
  result.payloadReason=result.payloadQuantActive?"exact quotient and remainder; separate native restoration":"no physical buffer saving including padding; raw fallback";
  return result;
}
function lengthGraph(fields){
  const optional=fields.filter(f=>f.type.optional),domains=[];
  if(!optional.length||optional.length>12)return null;
  const number=t=>t?.t==="number"?Number(t.x.replaceAll("_","")):null;
  for(const f of optional){const t=f.type,n=t.name.x,s=t.size;let min,max,variable=false;
    if(/^([ui])(8|16|32|64)$/.test(n)){min=max=Number(n.slice(1))/8;}
    else if(["str","string","String"].includes(n)&&s&&f.modifiers.decompress!=="true"){
      min=number(s.kind==="range"?s.lo:s.tok);max=number(s.kind==="range"?s.hi:s.tok);variable=min!==max;
    }else return null;
    if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<0||max<min)return null;domains.push({min,max,variable});
  }
  const maxPayload=domains.reduce((n,f)=>n+f.max,0);if(maxPayload>65535)return null;
  const changes=new Map(),add=(at,mask,delta)=>{if(!changes.has(at))changes.set(at,[]);changes.get(at).push([mask,delta]);};
  for(let mask=0;mask<2**domains.length;mask++){let lo=0,hi=0;domains.forEach((f,j)=>{if(mask&(1<<j)){lo+=f.min;hi+=f.max;}});add(lo,mask,1);add(hi+1,mask,-1);}
  const active=new Set(),events=[],points=[...changes.keys()].sort((a,b)=>a-b);
  for(let i=0;i<points.length-1;i++){for(const [m,delta]of changes.get(points[i])){if(delta===1)active.add(m);else active.delete(m);}let forced=(1<<domains.length)-1,possible=0;for(const m of active){forced&=m;possible|=m;}const next={start:points[i],end:points[i+1]-1,forced:active.size?forced:0,possible,valid:active.size>0},last=events.at(-1);if(last&&last.forced===next.forced&&last.possible===next.possible&&last.valid===next.valid)last.end=next.end;else events.push(next);}
  const tagBytes=events.some(e=>e.valid&&e.forced!==e.possible)?Math.ceil(domains.length/8):0;
  const last=domains.findLastIndex(f=>f.variable);let metadataBytes=tagBytes;domains.forEach((f,i)=>{if(f.variable&&i!==last)metadataBytes+=f.max<=255?1:f.max<=65535?2:4;});
  return {events,tagBytes,metadataBytes,maxPayload,domains};
}
function analyzeLayout(structs, configs = {}) {
  const plans = [], diags = [];
  for (const s of structs) {
    let maximum = 0, bits = 0, variableSeen = false, suggestFixedPrefix = false;
    const fields = [...s.fields.values()], optional = fields.filter(f => f.type.optional);
    const attrs = {...(s.attrs || {})}, qps=Object.hasOwn(attrs,"qps")||Object.hasOwn(attrs,"quant"),state_bits=Object.hasOwn(attrs,"state_bits");
    const quantum = state_bits ? Number((attrs.state_bits || "Q1").replace("Q", "")) : 1;
    const error = (token, m) => diags.push({s:token.s,e:token.e,m,sev:1});
    if(Object.hasOwn(attrs,"qps")&&Object.hasOwn(attrs,"quant"))error(s.name,"qps and quant are aliases; specify only one");
    if(Object.hasOwn(attrs,"qps"))attrs.quant=attrs.qps||"Q16";
    for (const [k,v] of Object.entries(attrs)) {
      if(k==="macro")error(s.name,"Mark the Rust struct with #[qsl::qsl_macro] or #[qsl::schem_macro]; [macro] is not a QSL attribute");
      else if (!["qps","state_bits","quant","predict_seq","opt_table","inline","compact","alignment","lifetime","safety","optionals"].includes(k)) error(s.name,`Unknown schema attribute '${k}'`);
      if (k === "state_bits" && ![1,2,4,8,16].includes(quantum)) error(s.name,"state_bits quantum must be Q1, Q2, Q4, Q8 or Q16");
      if (k === "inline" && v && !["hint","always","never"].includes(v)) error(s.name,"inline expects hint, always or never");
      if(["qps","quant"].includes(k)&&v&&!["Q2","Q4","Q8","Q16"].includes(v))error(s.name,"quant expects Q2, Q4, Q8 or Q16");
      if(k==="opt_table"&&v&&!["static","legacy"].includes(v))error(s.name,"opt_table expects static or legacy");
    }
    const predictive = state_bits || Object.hasOwn(attrs,"predict_seq")&&!Object.hasOwn(attrs,"opt_table");
    const staticOptional=Object.hasOwn(attrs,"opt_table")&&attrs.opt_table!=="legacy";
    if(attrs.opt_table==="legacy"&&(state_bits||Object.hasOwn(attrs,"predict_seq")))error(s.name,"Legacy wire offsets conflict with predictive layouts");
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
      if(state_bits && t.optional && string && hi!==null && !compression)width=hi;
      if (!f.type.optional) {if (width === null) variableSeen = true; else if(variableSeen) suggestFixedPrefix = true;}
      if (width === null || !Number.isSafeInteger(width)) maximum = null;
      else if(maximum !== null) maximum += width;
      if (f.type.optional) {
        if (string && !fixedString) {
          widths.push(null);
          if (hi === null || lo === null || compression) {if(state_bits) error(f.name,"state_bits needs finite raw UTF-8 byte bounds; keep the plain codec for compressed/unbounded fields");}
          else bits += Math.ceil(Math.log2(hi-lo+2));
        } else {widths.push(width);bits++;if(compression&&state_bits)error(f.name,"state_bits does not reinterpret compressed UTF-8 as raw bytes");}
      }
    }
    if (state_bits && bits>32) error(s.name,`DIRECT_BITS requires ${bits} bits; D has 32. Disable state_bits or split the schema.`);
    let reason = "legacy codec", indexBytes = 0, plainIndexBytes = 0;
    if (predictive||staticOptional) {
      reason = "direct D extraction";
      if (widths.every(n=>n!==null) && widths.length <=12 && widths.reduce((a,b)=>a+b,0)<=65535) {
        const sums = new Set();let collision=false;
        for(let mask=0;mask<2**widths.length;mask++){let total=0;for(let j=0;j<widths.length;j++)if(mask&(1<<j))total+=widths[j];if(sums.has(total)){collision=true;break;}sums.add(total);}
        if(!collision){const size=widths.reduce((a,b)=>a+b,0)+1;plainIndexBytes=size*4;indexBytes=Math.ceil(size/quantum)*4;reason="exact static subset-sum lookup";}
        else reason="ambiguous subset sums: direct D is required";
      } else reason="variable lengths or table analysis budget: direct D extraction";
      if(!state_bits && predictive && optional.length>1 && !plainIndexBytes)error(s.name,"Non-quantized predict_seq needs unique fixed-size subset sums within the table budget; use state_bits or opt_table");
      if(quantum>1 && !plainIndexBytes)error(s.name,"Selected Q_table cannot reconstruct this layout from length; use unquantized state_bits (D) or opt_table");
    }
    const graph=staticOptional&&!state_bits?lengthGraph(fields):null;
    if(graph&&maximum!==null){
      const encodedOptional=optional.reduce((sum,f)=>{const n=f.type.name.x,sz=f.type.size;if(["str","string","String"].includes(n)){const lo=Number((sz.kind==="range"?sz.lo:sz.tok).x),hi=Number((sz.kind==="range"?sz.hi:sz.tok).x);return sum+hi+(lo===hi?0:f.modifiers.binary_opt==="inline"?hi<=127?1:hi<=32767?2:4:4);}return sum+Number(n.slice(1))/8;},0);
      maximum+=graph.maxPayload-encodedOptional;
    }
    if(maximum!==null){
      if(state_bits)maximum+=4;
      else if(graph)maximum+=graph.metadataBytes;
      else if(staticOptional)maximum+=plainIndexBytes||optional.length===0||optional.length===1&&widths[0]!==0?0:Math.ceil(optional.length/8);
      else if(attrs.opt_table==="legacy"&&optional.length>1)maximum+=1+4*optional.length;
      else if(attrs.opt_table==="legacy"&&optional.length===1){}
      else if(!Object.hasOwn(attrs,"predict_seq")&&optional.length)maximum+=Math.ceil((optional.length===1?1:Math.ceil(Math.log2(optional.length+1))+optional.length*Math.ceil(Math.log2(Math.max(1,fields.length))))/8);
    }
    const payload=payloadPlan(fields,attrs,maximum);
    if(payload.payloadQuantActive){maximum=payload.payloadMaximum;if(Object.hasOwn(attrs,"predict_seq")&&!staticOptional)error(s.name,"quant cannot infer field presence from compressed byte length; use opt_table or state_bits");if(state_bits&&quantum!==1)error(s.name,"Payload bit-prefix graphs use direct D, not Q_table length lookup; combine quant with plain state_bits");}
    if(qps&&!payload.payloadQuantActive&&fields.length===1&&fields[0].type.name.x==="u8")diags.push({s:fields[0].name.s,e:fields[0].name.e,sev:2,m:"A single u8 cannot benefit from grouping; exact QPS keeps raw data when framing costs more"});
    const slots=Number(configs.QSL_RT_DEFAULT||16),eligible=maximum!==null&&(maximum+payload.payloadPadding)*slots<=64*1024*1024;
    const mode=payload.payloadQuantActive&&staticOptional?"packed bit-prefix Boolean graph":staticOptional?(plainIndexBytes?"static critical lengths; no wire directory":"static prefix graph with presence bits or EOF predicate; no wire directory"):attrs.opt_table==="legacy"?"legacy wire offset directory":"disabled";
    plans.push({sourceFields:fields,compact:Object.hasOwn(attrs,"compact"),name:s.name.x,maximum,rtEligible:eligible,rtEnabled:configs.QSL_RT==="true"&&eligible,slots,qps,qpsByteCodecRevision:3,qpsByteHeader:16,qpsByteMaximum:maximum===null?null:maximum+16,qpsByteAPI:true,stateBits:state_bits,stateBitsQuantum:quantum,quantum:qps?payload.payloadQuantum:quantum,dBits:bits,indexBytes,plainIndexBytes,reason,staticOptional:mode,lengthGraph:payload.payloadQuantActive?null:graph,predictSequenceHint:staticOptional&&Object.hasOwn(attrs,"predict_seq"),optionalNames:optional.map(f=>f.name.x),...payload,inline:Object.hasOwn(attrs,"inline")?(attrs.inline||"hint"):"compiler default",optionalCount:optional.length,fieldCount:fields.length,optionalTailRequired:strictTail,safety:true,maxDataSize:Number(configs.MAX_DATA_SIZE||65535),suggestFixedPrefix,approximate:true});
  }
  return {plans,diags};
}
function describe(p,language="en") {
  const ui=require("./editor-features"),{t,diagnostic}=require("./i18n");
  const st={name:{x:p.name},fields:new Map((p.sourceFields||[]).map(f=>[f.name.x,f])),attrs:p.compact?{compact:""}:{}};
  return ui.schemaHover(st,p,language)+`\n\n**${t(language,"strategy")}**: ${diagnostic(p.staticOptional&&p.staticOptional!=="disabled"?p.staticOptional:p.reason,language)}`+(p.lengthGraph?`\n\n\`I = ${ui.formula(p)}\``:"");
}
module.exports={analyzeLayout,describe};
