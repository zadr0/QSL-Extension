"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{spawnSync,spawn}=require("node:child_process"),path=require("node:path"),fs=require("node:fs");
const {analyze,editorAnalysis}=require("./qsl-server"),{describe}=require("./layout-engine");
test("DEQ RT config and invalid limits",()=>{
  assert.equal(analyze("!config QSL_RT = true;!config QSL_RT_DEFAULT = 16;",{kind:"deq"}).diags.length,0);
  for(const v of ["0","65","false"]){assert(analyze(`!config QSL_RT_DEFAULT = ${v};`,{kind:"deq"}).diags.some(d=>d.sev===1));}
});
test("optional tail constraint and advisory wire migration",()=>{
  const a=analyze("&A{u8? a;u64 required;}");assert(a.diags.some(d=>/precede all optional/.test(d.m)));
  assert(analyze("&A{u8? a;u64 required;}").diags.some(d=>d.sev===1));
  assert.equal(analyze("&A{u64 required;u8? a;}").diags.filter(d=>d.sev===1).length,0);
});
test("exact quantum plans, pool bounds, inline modes",()=>{
  for(const q of [1,2,4,8,16]){
    const a=analyze(`&A[state_bits=Q${q},inline=never]{u32 id;u8? a;u16? b;u32? c;}`);
    assert.equal(a.diags.filter(d=>d.sev===1).length,0);assert.equal(a.plans[0].maximum,15);assert.equal(a.plans[0].dBits,3);assert.equal(a.plans[0].indexBytes,Math.ceil(8/q)*4);
    assert.match(describe(a.plans[0]),/32 (?:bits|бит)/);
  }
  assert.equal(analyze("&A{str value;}").plans[0].rtEligible,false);
  assert(analyze("&A[state_bits=Q16]{u8? a;u8? b;}").diags.some(d=>/cannot reconstruct/.test(d.m)));
  assert(analyze("&A[state_bits=Q3]{u8? a;}").diags.some(d=>d.sev===1));
});
test("compression and field modifiers are retained",()=>{
  const a=analyze("&A{str(0..100) a|binary_opt=guard|;str?(0..255) b|decompress=true|;}");
  assert.equal(a.diags.filter(d=>d.sev===1).length,0);assert.equal(a.structs[0].fields.get("b").modifiers.decompress,"true");
});
test("macro marking belongs to Rust declarations",()=>{
  assert(analyze("&Meta[macro]{u64 id;}").diags.some(d=>/Mark the Rust struct/.test(d.m)));
  const a=analyze("&P{Meta first;u8? tail;}");assert.equal(a.structs.length,1);assert.equal(a.plans[0].maximum,null);
});
test("an old or incompatible native bridge leaves a labelled advisory plan",()=>{
  const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=process.execPath;
  try{const r=editorAnalysis("&P{u64 id;}","file:///tmp/model.qsl",{kind:"qsl"});assert.equal(r.plans[0].approximate,true);assert(r.diags.some(d=>/source-bundle protocol/.test(d.m)));}
  finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
const native=path.resolve(__dirname,"../../../qsl/target/release/qsl-analyze.exe");
test("opt_table dispatch is independent of length prediction and legacy directories",()=>{
  const source="{u32 id;u8? a;u16? b;u32? c;}";
  const a=analyze("&A[opt_table]"+source);assert.equal(a.plans[0].maximum,12);assert.match(describe(a.plans[0]),/tag-indexed reader dispatch/);assert.equal(a.plans[0].lengthGraph,null);assert.equal(a.plans[0].predictSequence,false);assert.equal(a.plans[0].tagDispatch,true);
  assert.equal(analyze("&A[opt_table=legacy]"+source).plans[0].maximum,24);
  assert.equal(analyze("&A[opt_table]{u32 id;u8? a;u8? b;}").plans[0].maximum,7);
  assert.equal(analyze("&A[opt_table]{u32 id;str?(0) empty;}").plans[0].maximum,5);
});
test("length graph distinguishes equal scalars and forced string presence",()=>{
  const a=analyze("&P[predict_seq,opt_table]{i32 id;u8? a;u8? b;}").plans[0];assert.deepEqual(a.lengthGraph.events.map(e=>[e.start,e.end,e.forced,e.possible]),[[0,0,0,0],[1,1,0,3],[2,2,3,3]]);
  const s=analyze("&S[predict_seq,opt_table]{u32 id;str?(3..33) name;str?(1..255) description;}").plans[0];assert.equal(s.maximum,294);assert.equal(s.lengthGraph.metadataBytes,2);const at34=s.lengthGraph.events.find(e=>e.start<=34&&e.end>=34);assert.equal(at34.forced,2);assert.equal(at34.possible,3);assert.match(describe(s),/\(L > 33\) as usize/);
  assert.equal(analyze("&P[opt_table,predict_seq]{i32 id;u8? a;u8? b;}").diags.filter(d=>d.sev===1).length,0);
});
test("exact numerical payload plans retain both operands and show raw fallback",()=>{
  const fields="{u64(0..15) a;u64(0..15) b;u64(0..15) c;u64(0..15) d;}";
  for(const q of [2,4,8,16]){
    const a=analyze(`&A[quant=Q${q},safety]`+fields);assert.equal(a.diags.filter(d=>d.sev===1).length,0,JSON.stringify(a.diags));
    assert.equal(a.plans[0].payloadQuantActive,true);assert.equal(a.plans[0].maximum,2);assert.equal(a.plans[0].payloadPadding,0);assert.match(describe(a.plans[0]),/quotient and remainder retained/);
  }
  assert.equal(analyze("&A[quant=Q16]{u64 a;}").plans[0].payloadQuantActive,false);
  assert(analyze("&A[quant=Q3]{u64 a;}").diags.some(d=>d.sev===1));
});
test("native payload and static graph plans match the generator",{skip:!fs.existsSync(native)},()=>{
  const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
  try{
    const result=editorAnalysis("&A[quant=Q16,opt_table,safety]{u64(0..15) a;u64(0..15) b;u64(0..15) c;u64?(0..15) d;}","file:///tmp/quant.qsl",{kind:"qsl"});
    assert.equal(result.diags.filter(d=>d.sev===1).length,0,JSON.stringify(result.diags));const p=result.plans[0];
    assert.equal(p.payloadQuantActive,true);assert.equal(p.maximum,3);assert.equal(p.payloadPadding,0);assert.match(p.staticOptional,/no wire tags/);assert.equal(p.tagDispatch,false);
  }finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
test("native generator plans agree with advisory quantum analysis",{skip:!fs.existsSync(native)},()=>{
  const previous=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
  try {for(const q of [1,2,4,8,16]){
    const source=`&A[state_bits=Q${q}]{u32 id;u8? a;u16? b;u32? c;}`;
    const result=editorAnalysis(source,"file:///tmp/test.qsl",{kind:"qsl"});assert(!result.plans[0].approximate);assert.equal(result.plans[0].indexBytes,Math.ceil(8/q)*4);assert.equal(result.plans[0].maximum,15);
  }}finally{if(previous===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=previous;}
});
test("native analysis uses unsaved DEQ values and rejects invalid config",{skip:!fs.existsSync(native)},()=>{
  const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
  try{
    const deq="!define MAX: usize = sizeof(u64) * 16;!config QSL_RT = true;!config QSL_RT_DEFAULT = 16;";
    const {pathToFileURL}=require("node:url"),root=path.resolve(__dirname,"editor-fixture");
    const report=editorAnalysis("&A{str(0..!MAX) text;}",pathToFileURL(path.join(root,"model.qsl")).href,{kind:"qsl",openDocs:new Map([[pathToFileURL(path.join(root,"schema.deq")).href,deq]])});
    assert.equal(report.diags.filter(d=>d.sev===1).length,0,JSON.stringify(report.diags));assert.equal(report.plans[0].maximum,132);assert.equal(report.plans[0].rtEnabled,true);
    assert(editorAnalysis("!config QSL_RT_DEFAULT = 0;","file:///tmp/schema.deq",{kind:"deq"}).diags.some(d=>d.sev===1));
  }finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
test("native editor expands nested macros from unsaved neighboring files",{skip:!fs.existsSync(native)},()=>{
  const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
  try{
    const {pathToFileURL}=require("node:url"),root=path.resolve(__dirname,"editor-fixture");
    const uri=pathToFileURL(path.join(root,"use.qsl")).href,defs=pathToFileURL(path.join(root,"models.rs")).href;
    const report=editorAnalysis("&Packet{Meta meta;}",uri,{kind:"qsl",openDocs:new Map([[defs,"#[qsl::qsl_macro] struct Meta{base:Base,kind:u16} #[qsl::schem_macro] struct Base{id:u64}"]])});
    assert.equal(report.diags.filter(d=>d.sev===1).length,0,JSON.stringify(report.diags));assert.equal(report.plans.find(p=>p.name==="Packet").fieldCount,2);assert.equal(report.plans.find(p=>p.name==="Packet").maximum,10);
    assert(!report.diags.some(d=>d.m==="Unknown type 'Meta'"));
    for(const [q,r]of [["&P{M m;}","#[qsl_macro]struct M{x:M}"],["&P{M m;u8 required;}","#[qsl_macro]struct M{x:Option<u8>}"]])assert(editorAnalysis(q,uri,{kind:"qsl",openDocs:new Map([[defs,r]])}).diags.some(d=>d.sev===1));
    const large="//"+"a".repeat(40000)+"\n#[qsl_macro]struct Wide{id:u64}";assert.equal(editorAnalysis("&P{Wide data;}",uri,{kind:"qsl",openDocs:new Map([[defs,large]])}).plans[0].maximum,8);
  }finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
test("LSP stdio: diagnostics, hover and optional-tail quickfix",async()=>{
  const child=spawn(process.execPath,[path.join(__dirname,"qsl-server.js")],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  const messages=[];let buffer=Buffer.alloc(0);child.stdout.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const split=buffer.indexOf("\r\n\r\n");if(split<0)break;const len=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,split).toString())[1]);if(buffer.length<split+4+len)break;messages.push(JSON.parse(buffer.subarray(split+4,split+4+len)));buffer=buffer.subarray(split+4+len);}});
  const send=m=>{const body=JSON.stringify({jsonrpc:"2.0",...m});child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);};
  const awaitMessage=predicate=>new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const m=messages.find(predicate);if(m){clearInterval(timer);resolve(m);}else if(Date.now()-start>5000){clearInterval(timer);reject(new Error("LSP response timeout"));}},10);});
  try{
    send({id:1,method:"initialize",params:{}});assert.equal((await awaitMessage(m=>m.id===1)).result.capabilities.hoverProvider,true);
    const uri="file:///tmp/test.qsl",text="&A[state_bits=Q16]{u32 id;u8? a;u16? b;u32? c;}";
    send({method:"textDocument/didOpen",params:{textDocument:{uri,text}}});await awaitMessage(m=>m.method==="textDocument/publishDiagnostics");
    send({id:2,method:"textDocument/hover",params:{textDocument:{uri},position:{line:0,character:2}}});assert.match((await awaitMessage(m=>m.id===2)).result.contents.value,/Q16/);
    send({method:"textDocument/didChange",params:{textDocument:{uri},contentChanges:[{text:"&A{u8? a;u64 required;}"}]}});
    send({id:3,method:"textDocument/codeAction",params:{textDocument:{uri},range:{start:{line:0,character:0},end:{line:0,character:24}},context:{diagnostics:[]}}});
    const actions=(await awaitMessage(m=>m.id===3)).result;assert.equal(actions.length,1);assert.match(actions[0].title,/wire format changes/);
  }finally{child.kill();}
});

test("QPS is operand compression and does not require optional fields",()=>{
 for(const q of [2,4,8,16]){const r=analyze(`&P[qps=Q${q},safety]{u64(0..15) a;u64(0..15) b;}`);assert.equal(r.diags.filter(d=>d.sev===1).length,0,JSON.stringify(r.diags));assert(r.plans[0].qps);assert(r.plans[0].payloadQuantActive);assert.equal(r.plans[0].stateBits,false);assert.equal(r.plans[0].maximum,1);}
 const p=analyze("&P[qps]{u64(0..15) a;}").plans[0];assert.equal(p.quantum,16);
 assert(analyze("&P[qps=Q2,quant=Q4]{u64 a;}").diags.some(d=>d.sev===1));
 assert(analyze("&P[qps=Q1]{u64 a;}").diags.some(d=>d.sev===1));
});
test("native QPS expands the screenshot's Rust template before optional analysis",{skip:!fs.existsSync(native)},()=>{
 const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
 try{const {pathToFileURL}=require("node:url"),u=pathToFileURL(path.resolve(__dirname,"editor-fixture/qps-macro.qsl")).href,rs=u.replace("qps-macro.qsl","models.rs");
 const r=editorAnalysis("&MacroPredict[qps=Q16,safety]{u32 id;OptionalNumbers extras;}",u,{kind:"qsl",openDocs:new Map([[rs,"#[qsl::qsl_macro]pub struct OptionalNumbers{a:Option<u8>,b:Option<u16>,c:Option<u32>}"]])});
 assert.equal(r.diags.filter(d=>d.sev===1).length,0,JSON.stringify(r.diags));assert.equal(r.plans[0].fieldCount,4);assert(r.plans[0].qps);assert.equal(r.plans[0].qpsCodecRevision,2);assert(!r.plans[0].stateBits);assert.equal(r.plans[0].payloadQuantActive,false);assert.equal(r.plans[0].dBits,0);
 const exact=editorAnalysis("&P[qps,safety]{u64(0..15) a;u64(0..15) b;}",u,{kind:"qsl"});assert.equal(exact.plans[0].quantum,16);assert.equal(exact.plans[0].maximum,1);assert.equal(exact.plans[0].wireLayout.headerMaxBits,0);
 }finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});

test("schema hash config validation and bilingual completions",()=>{
  const ui=require("./editor-features"),i18n=require("./i18n");
  for(const value of ["xxHash","xxHash128","XXH3_64","XXH3_128"])assert.equal(analyze(`!config USE_HASH = ${value};`,{kind:"deq"}).diags.length,0);
  for(const value of ["md5","128","true"])assert(analyze(`!config USE_HASH = ${value};`,{kind:"deq"}).diags.some(d=>d.sev===1));
  assert(analyze("!config USE_HASH = xxHash;!config USE_HASH = xxHash128;",{kind:"deq"}).diags.some(d=>d.sev===1));
  for(const lang of ["ru","en"]){
    const text="!config USE_HASH = ",r=analyze(text,{kind:"deq"}),items=ui.completions(r,text,text.length,lang).items;
    assert.deepEqual(items.map(i=>i.label),["xxHash","xxHash128"]);
    assert.match(items[0].documentation.value,/XXH3-64/);
    const prefix="!config ";assert(ui.completions(r,prefix,prefix.length,lang).items.some(i=>i.label==="USE_HASH"));
  }
  assert.match(i18n.diagnostic("USE_HASH expects xxHash or xxHash128","ru"),/принимает/);
});

test("checked deserialization is opt-in and maximum data config is bounded",()=>{
 const a=analyze("&P{str text;}");assert.equal(a.plans[0].safety,false);assert.equal(a.plans[0].maxDataSize,65535);assert.equal(a.plans[0].qpsByteAPI,false);assert.equal(analyze("&P[safety]{u64 id;}").plans[0].qpsByteAPI,true);
 assert.equal(analyze("!config MAX_DATA_SIZE = 65535;",{kind:"deq"}).diags.length,0);
 const prefix="!config MAX_DATA_SIZE = ",ui=require("./editor-features");assert(ui.completions(a,prefix,prefix.length,"ru").items.some(i=>i.label==="65535"));
 assert(analyze("!config MAX_DATA_SIZE = 0;",{kind:"deq"}).diags.some(d=>d.sev===1));
});

test("native and advisory distinguish tag-only and combined optional modes",{skip:!fs.existsSync(native)},()=>{
 const old=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
 try{for(const attrs of ["opt_table","predict_seq,opt_table","predict_seq"]){
 const text=`&A[${attrs}]{u32 id;u8? a;u16? b;}`;
 const advisory=analyze(text).plans[0],exact=editorAnalysis(text,"file:///tmp/modes.qsl",{kind:"qsl"}).plans[0];
 assert.equal(Boolean(exact.approximate),false);for(const key of ["maximum","predictSequence","tagDispatch"])assert.equal(exact[key],advisory[key],`${attrs}: ${key}`);
 assert.equal(Boolean(exact.lengthGraph),Boolean(advisory.lengthGraph));
 }}finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
