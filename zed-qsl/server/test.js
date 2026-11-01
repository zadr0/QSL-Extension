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
    const a=analyze(`&A[qps=Q${q},inline=never]{u32 id;u8? a;u16? b;u32? c;}`);
    assert.equal(a.diags.filter(d=>d.sev===1).length,0);assert.equal(a.plans[0].maximum,15);assert.equal(a.plans[0].dBits,3);assert.equal(a.plans[0].indexBytes,Math.ceil(8/q)*4);
    assert.match(describe(a.plans[0]),/32 бит/);
  }
  assert.equal(analyze("&A{str value;}").plans[0].rtEligible,false);
  assert(analyze("&A[qps=Q16]{u8? a;u8? b;}").diags.some(d=>/cannot reconstruct/.test(d.m)));
  assert(analyze("&A[qps=Q3]{u8? a;}").diags.some(d=>d.sev===1));
});
test("compression and field modifiers are retained",()=>{
  const a=analyze("&A{str(0..100) a|binary_opt=guard|;str?(0..255) b|decompress=true|;}");
  assert.equal(a.diags.filter(d=>d.sev===1).length,0);assert.equal(a.structs[0].fields.get("b").modifiers.decompress,"true");
});
test("recursive macro expansion preserves standalone types and field constraints",()=>{
  const s="&P{Meta first;Meta second;u8? tail;}&Meta[macro]{Base base;u16 kind;}&Base[macro]{u64 id;}";
  const a=analyze(s);assert.equal(a.diags.filter(d=>d.sev===1).length,0);assert.equal(a.plans.find(p=>p.name==="P").fieldCount,5);assert(a.plans.find(p=>p.name==="Meta").structureMacro);
  for(const source of ["&A[macro]{A a;}","&M[macro]{u8 id;}&P{M m;u8 m_id;}","&M[macro]{u8? id;}&P{M m;u8 required;}"]){assert(analyze(source).diags.some(d=>d.sev===1));}
  let empty="&M0[macro]{}";for(let i=1;i<32;i++)empty+=`&M${i}[macro]{M${i-1} a;M${i-1} b;}`;assert.equal(analyze(empty).diags.filter(d=>d.sev===1).length,0);
});
const native=path.resolve(__dirname,"../../../qsl/target/release/qsl-analyze.exe");
test("native generator plans agree with advisory quantum analysis",{skip:!fs.existsSync(native)},()=>{
  const previous=process.env.QSL_ANALYZER;process.env.QSL_ANALYZER=native;
  try {for(const q of [1,2,4,8,16]){
    const source=`&A[qps=Q${q}]{u32 id;u8? a;u16? b;u32? c;}`;
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
    const uri=pathToFileURL(path.join(root,"use.qsl")).href,defs=pathToFileURL(path.join(root,"defs.qsl")).href;
    const report=editorAnalysis("&Packet{Meta meta;}",uri,{kind:"qsl",openDocs:new Map([[defs,"&Meta[macro]{Base base;u16 kind;}&Base[macro]{u64 id;}"]])});
    assert.equal(report.diags.filter(d=>d.sev===1).length,0,JSON.stringify(report.diags));assert.equal(report.plans.find(p=>p.name==="Packet").fieldCount,2);assert.equal(report.plans.find(p=>p.name==="Packet").maximum,10);
  }finally{if(old===undefined)delete process.env.QSL_ANALYZER;else process.env.QSL_ANALYZER=old;}
});
test("LSP stdio: diagnostics, hover and optional-tail quickfix",async()=>{
  const child=spawn(process.execPath,[path.join(__dirname,"qsl-server.js")],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  const messages=[];let buffer=Buffer.alloc(0);child.stdout.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const split=buffer.indexOf("\r\n\r\n");if(split<0)break;const len=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,split).toString())[1]);if(buffer.length<split+4+len)break;messages.push(JSON.parse(buffer.subarray(split+4,split+4+len)));buffer=buffer.subarray(split+4+len);}});
  const send=m=>{const body=JSON.stringify({jsonrpc:"2.0",...m});child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);};
  const awaitMessage=predicate=>new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const m=messages.find(predicate);if(m){clearInterval(timer);resolve(m);}else if(Date.now()-start>5000){clearInterval(timer);reject(new Error("LSP response timeout"));}},10);});
  try{
    send({id:1,method:"initialize",params:{}});assert.equal((await awaitMessage(m=>m.id===1)).result.capabilities.hoverProvider,true);
    const uri="file:///tmp/test.qsl",text="&A[qps=Q16]{u32 id;u8? a;u16? b;u32? c;}";
    send({method:"textDocument/didOpen",params:{textDocument:{uri,text}}});await awaitMessage(m=>m.method==="textDocument/publishDiagnostics");
    send({id:2,method:"textDocument/hover",params:{textDocument:{uri},position:{line:0,character:2}}});assert.match((await awaitMessage(m=>m.id===2)).result.contents.value,/Q16/);
    send({method:"textDocument/didChange",params:{textDocument:{uri},contentChanges:[{text:"&A{u8? a;u64 required;}"}]}});
    send({id:3,method:"textDocument/codeAction",params:{textDocument:{uri},range:{start:{line:0,character:0},end:{line:0,character:24}},context:{diagnostics:[]}}});
    const actions=(await awaitMessage(m=>m.id===3)).result;assert.equal(actions.length,1);assert.match(actions[0].title,/wire format changes/);
  }finally{child.kill();}
});
