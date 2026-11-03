"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs"),{spawn}=require("node:child_process"),{pathToFileURL,fileURLToPath}=require("node:url");
const {editorAnalysis}=require("./qsl-server"),ui=require("./editor-features"),i18n=require("./i18n");
const native=path.resolve(__dirname,"../../../qsl/target/release/qsl-analyze.exe"),source="&Packet[predict_seq,opt_table,safety]{i32 id;u8? a;u8? b;}",uri=pathToFileURL(path.resolve(__dirname,"editor-fixture/packet.qsl")).href;
function client(language="en",extra={}){
 const child=spawn(process.execPath,[path.join(__dirname,"qsl-server.js")],{stdio:["pipe","pipe","pipe"],windowsHide:true,env:{...process.env,QSL_ANALYZER:fs.existsSync(native)?native:"",QSL_ANALYSIS_DIR:path.join(__dirname,".analysis")}});
 let buffer=Buffer.alloc(0),seq=0;const pending=new Map(),notifications=[],shown=[];let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);
 const send=message=>{const body=JSON.stringify({jsonrpc:"2.0",...message});child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);};
 child.stdout.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf("\r\n\r\n");if(end<0)return;const len=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+len)return;const message=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);
  if(message.method==="window/showDocument"){shown.push(message.params.uri);send({id:message.id,result:{success:true}});}
  else if(["client/registerCapability","workspace/inlayHint/refresh","workspace/codeLens/refresh"].includes(message.method))send({id:message.id,result:null});
  else if(pending.has(message.id)){const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(new Error(message.error.message));else p.resolve(message.result);}
  else notifications.push(message);
 }});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`timeout ${method}: ${stderr}`));},7000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
 const wait=(predicate)=>new Promise((resolve,reject)=>{const start=Date.now(),poll=setInterval(()=>{const item=notifications.find(predicate);if(item){clearInterval(poll);resolve(item);}else if(Date.now()-start>7000){clearInterval(poll);reject(new Error(`notification timeout: ${stderr}`));}},10);});
 return {child,shown,send,request,wait,initialize:()=>request("initialize",{locale:"en-US",initializationOptions:{language,...extra},capabilities:{window:{showDocument:{support:true}},workspace:{didChangeWatchedFiles:{dynamicRegistration:true},inlayHint:{refreshSupport:true},codeLens:{refreshSupport:true}}}}),open:(text=source,version=1,u=uri)=>send({method:"textDocument/didOpen",params:{textDocument:{uri:u,version,languageId:"qsl",text}}}),close:()=>{child.kill();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("closed"));}}};
}
test("RU/EN catalogs translate diagnostics, preserving technical tokens",()=>{
 assert.equal(i18n.select({language:"ru"},"en-US"),"ru");assert.equal(i18n.select({language:"auto"},"ru-RU"),"ru");assert.equal(i18n.select({},"en-GB"),"en");
 assert.match(i18n.diagnostic("Duplicate field 'id' in struct 'P'","ru"),/Повторное поле 'id'/);assert.equal(i18n.diagnostic("invalid numeric range","en"),"invalid numeric range");
 assert.match(i18n.diagnostic("QSL at byte 17: invalid numeric range","ru"),/байт 17: Недопустимый числовой диапазон/);
});
test("native wire layout distinguishes fixed/dynamic offsets and never invents sizeof",{skip:!fs.existsSync(native)},()=>{
 const r=editorAnalysis(source,uri,{analyzerPath:native}),p=r.plans[0],w=p.wireLayout;
 assert.equal(p.maximum,7);assert.equal(w.minimumBytes,5);assert.equal(w.nativeSize,null);assert.deepEqual(w.fields.map(f=>[f.name,f.offsetMinBits,f.offsetMaxBits]),[["id",8,8],["a",40,40],["b",40,48]]);
 assert.equal(w.fields[2].rustType,"Option<u8>");assert.match(w.fields[2].offsetExpr,/present\(a\)/);
 const unbounded=editorAnalysis("&P{str text;u64 end;}",uri,{analyzerPath:native}).plans[0];assert.equal(unbounded.maximum,null);assert.equal(unbounded.wireLayout.fields[1].offsetMaxBits,null);
 const quant=editorAnalysis("&P[quant=Q16]{u64(0..15) a;u64(0..15) b;}",uri,{analyzerPath:native}).plans[0];assert.equal(quant.wireLayout.fields[1].offsetMinBits,4);assert.equal(quant.wireLayout.fields[1].minBits,4);
});
for(const lang of ["ru","en"])test(`LSP ${lang}: inlays, compact field hover, outline, completions and live diagnostics`,async()=>{
 const c=client(lang);try{
  const init=await c.initialize();for(const cap of ["inlayHintProvider","codeLensProvider","documentSymbolProvider","definitionProvider","completionProvider"])assert(init.capabilities[cap]);c.send({method:"initialized",params:{}});c.open();
  const first=await c.wait(m=>m.method==="textDocument/publishDiagnostics"&&m.params.uri===uri&&m.params.version===1);assert.equal(first.params.diagnostics.length,0);
  const hints=await c.request("textDocument/inlayHint",{textDocument:{uri}});assert.equal(hints.length,4);assert.match(hints[0].label,/5…7 B/);assert.match(hints[3].label,/@5…6 B/);
  const hover=await c.request("textDocument/hover",{textDocument:{uri},position:{line:0,character:2}});assert.match(hover.contents.value,/\| --- \|/);assert.match(hover.contents.value,lang==="ru"?/Кадр/:/Frame/);assert(!hover.contents.value.includes(lang==="ru"?"Frame":"Кадр"));
  const field=await c.request("textDocument/hover",{textDocument:{uri},position:{line:0,character:source.indexOf(" b;")+1}});assert.match(field.contents.value,/Packet\.b/);assert.match(field.contents.value,/Option<u8>/);assert(!field.contents.value.includes("| QPS |"));
  const symbols=await c.request("textDocument/documentSymbol",{textDocument:{uri}});assert.equal(symbols[0].children.length,3);
  const completion=await c.request("textDocument/completion",{textDocument:{uri},position:{line:0,character:source.indexOf("opt_table")}});assert(completion.items.some(i=>i.label==="opt_table"));
  const wrong="&Bad{u32(9..1) id;u8? a;u64 after;}";c.send({method:"textDocument/didChange",params:{textDocument:{uri,version:2},contentChanges:[{text:wrong}]}});
  const errors=(await c.wait(m=>m.method==="textDocument/publishDiagnostics"&&m.params.version===2)).params.diagnostics;assert(errors.some(d=>d.severity===1));assert(errors.every(d=>d.range.end.character>d.range.start.character));assert(errors.some(d=>lang==="ru"?/диапазон|диапазона|предшествовать/.test(d.message):/Range start|precede/.test(d.message)));
  assert.equal((await c.request("textDocument/inlayHint",{textDocument:{uri}})).length,0);
  c.send({method:"textDocument/didChange",params:{textDocument:{uri,version:3},contentChanges:[{text:source}]}});assert.equal((await c.wait(m=>m.method==="textDocument/publishDiagnostics"&&m.params.version===3)).params.diagnostics.length,0);
  c.send({method:"workspace/didChangeConfiguration",params:{settings:{language:lang==="ru"?"en":"ru",inlayHints:{enabled:false}}}});assert.equal((await c.request("textDocument/inlayHint",{textDocument:{uri}})).length,0);
  const changed=await c.request("textDocument/hover",{textDocument:{uri},position:{line:0,character:2}});assert.match(changed.contents.value,lang==="ru"?/Frame/:/Кадр/);
 }finally{c.close();}
});
test("LSP commands open complete event/layout tables and actual generated Rust",{skip:!fs.existsSync(native)},async()=>{
 const c=client("en");try{await c.initialize();c.open();await c.wait(m=>m.method==="textDocument/publishDiagnostics");const lenses=await c.request("textDocument/codeLens",{textDocument:{uri}});assert.equal(lenses.length,3);
  for(const command of ["qsl.inspectLayout","qsl.inspectEvents","qsl.expandRust"]){const result=await c.request("workspace/executeCommand",{command,arguments:[{uri,schema:"Packet"}]});assert(c.shown.includes(result.uri));const content=fs.readFileSync(fileURLToPath(result.uri),"utf8");if(command==="qsl.expandRust")assert.match(content,/pub struct Packet/);else{assert.match(content,/\|/);assert.match(content,/\(L > 1\) as usize/);}}
 }finally{c.close();}
});
test("LSP partial edits and constant definition navigation use UTF-16 positions",async()=>{
 const c=client("en"),deq=uri.replace(/packet\.qsl$/,"schema.deq"),text="// 🦀\n&Packet{u32(0..!MAX) id;}";
 try{await c.initialize();c.open("!define MAX: u32 = 32;",1,deq);c.open(text);await c.wait(m=>m.method==="textDocument/publishDiagnostics"&&m.params.uri===uri);const def=await c.request("textDocument/definition",{textDocument:{uri},position:{line:1,character:19}});assert.equal(def[0].uri,deq);
  c.send({method:"textDocument/didChange",params:{textDocument:{uri,version:2},contentChanges:[{range:{start:{line:1,character:8},end:{line:1,character:11}},text:"u8"}]}});const errors=(await c.wait(m=>m.method==="textDocument/publishDiagnostics"&&m.params.uri===uri&&m.params.version===2)).params.diagnostics;assert.equal(errors.filter(d=>d.severity===1).length,0);
 }finally{c.close();}
});

test("macro field hover includes every expanded field instead of only its first child",{skip:!fs.existsSync(native)},()=>{
 const rust="#[qsl::qsl_macro]struct OptionalNumbers{a:Option<u8>,b:Option<u16>,c:Option<u32>}",text="&MacroPredict[qps=Q16,safety]{u32 id;OptionalNumbers extras;}",rs=uri.replace("packet.qsl","models.rs");
 const report=editorAnalysis(text,uri,{analyzerPath:native,openDocs:new Map([[rs,rust]])});const st=report.structs[0],plan=report.plans[0];const hover=ui.fieldHover(st,plan,"extras","en");for(const name of ["extras_a","extras_b","extras_c"])assert(hover.includes(name));
 const hints=ui.hints(report,text,"en",{},o=>({line:0,character:o}));assert(hints.some(h=>h.label.includes("3 expanded fields")));
});
test("whole-payload QPS is separate from scalar layout and emits a single-u8 warning",{skip:!fs.existsSync(native)},()=>{
 const r=editorAnalysis("&Single[qps,safety]{u8 value;}",uri,{analyzerPath:native});assert.equal(r.plans[0].qpsByteCodecRevision,3);assert.equal(r.plans[0].qpsByteHeader,16);assert.equal(r.plans[0].qpsByteMaximum,17);assert.equal(r.plans[0].qpsByteAPI,true);assert.equal(r.plans[0].payloadQuantActive,false);const warnings=r.diags.filter(d=>d.sev===2&&d.m.startsWith("A single u8"));assert.equal(warnings.length,1);assert.match(i18n.diagnostic(warnings[0].m,"ru"),/Одиночный u8/);assert(!r.diags.some(d=>d.sev===1));
});

test("native schema hashes: names, storage, config and layout inspector",{skip:!fs.existsSync(native)},()=>{
 const source="&Plain{str text;}",a=editorAnalysis(source,uri,{analyzerPath:native}),h=a.plans[0].hashes;
 assert.equal(h.algorithm,"xxHash");assert.equal(h.bits,64);assert.equal(h.version,1);assert.equal(h.strict.length,16);assert.equal(h.complete,true);
 const b=editorAnalysis("&Renamed{str data|binary_opt=guard|;}",uri,{analyzerPath:native}).plans[0].hashes;assert.equal(h.light,b.light);assert.notEqual(h.strict,b.strict);
 const {spawnSync}=require("node:child_process"),native128=JSON.parse(spawnSync(native,["--deq-text","!config USE_HASH = xxHash128;"],{input:source,encoding:"utf8",windowsHide:true}).stdout);
 assert(native128.ok);assert.equal(native128.schemas[0].hashes.bits,128);assert.equal(native128.schemas[0].hashes.light.length,32);
 for(const lang of ["ru","en"]){const inspected=ui.inspect(a.structs[0],a.plans[0],lang);assert(inspected.includes(h.strict));assert(inspected.includes(h.light));assert.match(inspected,lang==="ru"?/Строгий хэш/:/Strict hash/);}
 const opaque=editorAnalysis("&P{External value;}",uri,{analyzerPath:native}).plans[0];assert.equal(opaque.hashes.complete,false);
});
