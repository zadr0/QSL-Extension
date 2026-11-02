"use strict";
const {t,diagnostic}=require("./i18n");
const md=v=>String(v??"?").replaceAll("|","\\|").replaceAll("\n"," ");
const num=token=>{try{return token?.t==="number"?Number(BigInt(token.x.replaceAll("_",""))):null;}catch{return null;}};
function sourceField(f,p){
 const n=f.type.name.x,s=f.type.size,lo=s?num(s.kind==="range"?s.lo:s.tok):0,hi=s?num(s.kind==="range"?s.hi:s.tok):null;
 let min=null,max=null,rust=n;
 if(/^[ui](8|16|32|64)$/.test(n)){min=max=Number(n.slice(1));}
 else if(["str","String","string"].includes(n)){
  const fixed=s?.kind==="n",compressed=f.modifiers.decompress==="true",raw=f.type.optional&&(p.lengthGraph||p.qps);
  const header=fixed||raw?0:f.modifiers.binary_opt==="inline"||compressed?(hi<=127?1:hi<=32767?2:4):4;
  min=compressed?null:lo===null?null:(lo+header)*8;max=hi===null?null:(hi+header)*8;
  rust=fixed?`[u8; ${hi??"N"}]`:f.modifiers.binary_opt==="guard"?"Utf8CopyGuard":f.modifiers.binary_opt==="inline"?`InlineString<${hi??"N"}>`:f.modifiers.binary_opt==="view"?"&str":f.modifiers.binary_opt==="true"||f.modifiers.binary_opt==="bytes"?"&[u8]":"String";
 }
 if(p.payloadQuantActive&&/^[ui](8|16|32|64)$/.test(n)&&s&&lo!==null&&hi!==null){let span=BigInt(hi)-BigInt(lo);min=max=span===0n?0:span.toString(2).length;}
 if(p.compact&&!p.payloadQuantActive){min=max=null;}
 return {name:f.name.x,rustType:f.type.optional?`Option<${rust}>`:rust,optional:f.type.optional,minBits:min,maxBits:max};
}
function wire(st,p){
 if(p.wireLayout)return p.wireLayout;
 const n=p.optionalCount,attrs=st.attrs,packed=p.payloadQuantActive,compact=Object.hasOwn(attrs,"compact"),predict=Object.hasOwn(attrs,"predict_seq"),bits=x=>x?Math.ceil(Math.log2(x+1)):0;
 let min,max;
 if(packed){min=max=(p.qps?4:Math.ceil(n/8))*8;}
 else if(p.lengthGraph){min=max=p.lengthGraph.metadataBytes*8;}
 else if(p.qps){min=max=32;}else if(predict){min=max=0;}
 else if(attrs.opt_table==="legacy"&&n>1){min=max=(1+4*n)*8;}
 else if(Object.hasOwn(attrs,"opt_table")){min=max=p.maximum===null?null:0;}
 else if(attrs.optionals==="bitmap"){min=max=Math.ceil(st.fields.size/32)*32;}
 else{min=bits(n);max=min+(n>1?n*Math.ceil(Math.log2(Math.max(1,st.fields.size))):0);if(!compact){min=Math.ceil(min/8)*8;max=Math.ceil(max/8)*8;}}
 const headerMin=min,headerMax=max,fields=[],prior=[];
 for(const f of st.fields.values()){
  const row=sourceField(f,p);row.tag=fields.length+1;row.offsetMinBits=min;row.offsetMaxBits=max;row.offsetExpr="H"+(prior.length?" + "+prior.join(" + "):"");fields.push(row);
  min=min===null||(!row.optional&&row.minBits===null)?null:min+(row.optional?0:row.minBits);max=max===null||row.maxBits===null?null:max+row.maxBits;
  prior.push(row.optional?`present(${row.name}) * size(${row.name})`:`size(${row.name})`);
 }
 return {unit:packed||compact?"bit":"byte",minimumBytes:min===null?null:Math.ceil(min/8),headerMinBits:headerMin,headerMaxBits:headerMax,fields,approximate:true};
}
function range(min,max,lang,unit="B"){
 if(min===null||min===undefined)return max===null||max===undefined?t(lang,"unknown"):`?…${max} ${unit}`;
 if(max===null||max===undefined)return `${min}…∞ ${unit}`;
 return `${min===max?min:`${min}…${max}`} ${unit}`;
}
function bitRange(min,max,lang){return (min===null||min%8===0)&&(max===null||max%8===0)?range(min===null?null:min/8,max===null?null:max/8,lang):range(min,max,lang,t(lang,"bits"));}
function frameSize(st,p,lang){const min=wire(st,p).minimumBytes;return min===null&&p.maximum===null?t(lang,"dynamic"):range(min,p.maximum,lang);}
function table(headers,rows){return `| ${headers.map(md).join(" | ")} |\n| ${headers.map(()=>"---").join(" | ")} |\n${rows.map(row=>`| ${row.map(md).join(" | ")} |`).join("\n")}`;}
function fieldTable(st,p,lang,limit=8){const w=wire(st,p),rows=w.fields.slice(0,limit).map(f=>[`${f.name}${f.optional?"?":""}`,f.rustType,bitRange(f.offsetMinBits,f.offsetMaxBits,lang),bitRange(f.minBits,f.maxBits,lang)]);return table([t(lang,"field"),t(lang,"type"),t(lang,"offset"),t(lang,"size")],rows)+(w.fields.length>limit?`\n\n… +${w.fields.length-limit}`:"");}
function schemaHover(st,p,lang,showFields=true){
 const w=wire(st,p),meta=bitRange(w.headerMinBits,w.headerMaxBits,lang);
 const rows=[["QPS",p.qps?`Q${p.quantum} · D ${p.dBits}/32 ${t(lang,"bits")}`:t(lang,"off")],[t(lang,"frame"),frameSize(st,p,lang)],[t(lang,"metadata"),meta],["RT",p.rtEligible?`${t(lang,p.rtEnabled?"on":"off")} · ${p.slots} ${t(lang,"slots")}`:t(lang,"rtMissing")],[t(lang,"validation"),t(lang,p.safety?"on":"off")],["inline",diagnostic(p.inline,lang)],[t(lang,"source"),t(lang,p.approximate?"advisory":"native")]];
 if(p.payloadQuantRequested)rows.push([t(lang,"compression"),p.payloadQuantActive?`Q${p.payloadQuantum}: ${p.rawMaximum} → ${p.payloadMaximum} B · ${t(lang,"lossless")}`:diagnostic(p.payloadReason,lang)]);
 return `### ${md(p.name)}\n\n${table(["QSL",t(lang,"status")],rows)}\n\n${showFields?fieldTable(st,p,lang)+"\n\n":""}${t(lang,"sizeof")}`;
}
function storage(f,lang){const ty=f.rustType;if(ty.includes("Utf8CopyGuard"))return t(lang,"copied");if(ty.includes("Guard")||ty.includes("&"))return t(lang,"borrowed");if(ty.includes("String")&&!ty.includes("Inline"))return t(lang,"owned");if(ty.includes("[u8;"))return t(lang,"fixed");return null;}
function fieldHover(st,p,name,lang){const w=wire(st,p),f=w.fields.find(f=>f.name===name||f.name.startsWith(name+"_"));if(!f)return null;
 return `### ${md(st.name.x)}.${md(name)}\n\n\`\`\`rust\n${f.name}: ${f.rustType}\n\`\`\`\n\n${table(["QSL",t(lang,"status")],[[t(lang,"field"),t(lang,f.optional?"optional":"required")],[t(lang,"offset"),bitRange(f.offsetMinBits,f.offsetMaxBits,lang)],[t(lang,"size"),`${bitRange(f.minBits,f.maxBits,lang)}${f.optional?` · ${t(lang,"present")}`:""}`],["tag",f.tag],...(storage(f,lang)?[[t(lang,"storage"),storage(f,lang)]]:[])])}\n\n\`${f.offsetExpr}\`\n\n${t(lang,"conditional")}`;
}
function formula(p){const events=p.lengthGraph?.events||[];return events.length<=33?["0",...events.slice(1).map(e=>`(L > ${e.start-1}) as usize`)].join(" + "):"numeric hierarchy";}
function maskNames(mask,fields){let value=BigInt(mask);return fields.filter((_,i)=>(value>>BigInt(i))&1n).map(f=>f.name).join(", ")||"∅";}
function inspect(st,p,lang,eventsOnly=false){
 const w=wire(st,p),parts=[`# ${p.name} · ${t(lang,eventsOnly?"events":"layoutTitle")}`];
 if(!eventsOnly)parts.push(schemaHover(st,p,lang,false).replace(/^### .*\n\n/,""),`## ${t(lang,"fields")}`,fieldTable(st,p,lang,Infinity),`\`H = ${bitRange(w.headerMinBits,w.headerMaxBits,lang)}\``,t(lang,"layoutReason"));
 const g=p.lengthGraph;if(g){parts.push(`## ${t(lang,"events")}`,`\`I(L) = ${formula(p)}\``,table(["I","L (B)",t(lang,"guaranteed"),t(lang,"possible"),t(lang,"valid")],g.events.map((e,i)=>[i,range(e.start,e.end,lang,"B"),maskNames(e.forced,w.fields.filter(f=>f.optional)),maskNames(e.possible,w.fields.filter(f=>f.optional)),t(lang,e.valid?"yes":"no")])));}
 if(!eventsOnly)parts.push(`## ${t(lang,"strategy")}`,diagnostic(p.staticOptional&&p.staticOptional!=="disabled"?p.staticOptional:p.reason,lang),p.payloadQuantActive?`quant=Q${p.payloadQuantum} · ${p.rawMaximum} → ${p.payloadMaximum} B · ${t(lang,"padding")}: ${p.payloadPadding} B`:"",t(lang,"wireChange"));
 return parts.filter(Boolean).join("\n\n")+"\n";
}
function hints(report,text,lang,settings,pos){const out=[];if(settings.enabled===false)return out;
 for(const st of report.structs){const p=report.plans.find(p=>p.name===st.name.x);if(!p)continue;
  if(settings.schemas!==false)out.push({position:pos(st.end),label:` ↔ ${frameSize(st,p,lang)}`,kind:1,paddingLeft:true,tooltip:{kind:"markdown",value:schemaHover(st,p,lang)}});
  if(settings.fields!==false)for(const f of st.fields.values()){const row=wire(st,p).fields.find(r=>r.name===f.name.x||r.name.startsWith(f.name.x+"_"));if(!row)continue;const sizeKnown=row.minBits!==null||row.maxBits!==null,offsetKnown=row.offsetMinBits!==null||row.offsetMaxBits!==null;if(!sizeKnown&&(!offsetKnown||settings.offsets===false))continue;out.push({position:pos(f.name.e),label:`${sizeKnown?`: ${bitRange(row.minBits,row.maxBits,lang)}`:""}${settings.offsets===false||!offsetKnown?"":` @${bitRange(row.offsetMinBits,row.offsetMaxBits,lang)}`}`,kind:1,paddingLeft:true,tooltip:{kind:"markdown",value:fieldHover(st,p,f.name.x,lang)}});}
 }return out;
}
const attrs={opt_table:"optDoc",predict_seq:"predictDoc",qps:"qpsDoc",quant:"quantDoc",inline:"inlineDoc",safety:"safetyDoc",lifetime:"fieldDoc",compact:"fieldDoc",alignment:"fieldDoc",optionals:"fieldDoc"};
function completions(report,text,at,lang){const prefix=text.slice(0,at),line=prefix.slice(Math.max(prefix.lastIndexOf("{"),prefix.lastIndexOf(";"),prefix.lastIndexOf("}"))+1);let items=[];
 const item=(label,insert,key,kind=14)=>({label,kind,insertText:insert||label,documentation:{kind:"markdown",value:t(lang,key)}});
 if(/\[[^\]]*$/.test(line)){const key=/([a-z_]+)\s*=\s*\w*$/.exec(line)?.[1];if(key){const values={inline:["hint","always","never"],opt_table:["static","legacy"],quant:["Q2","Q4","Q8","Q16"],qps:["Q1","Q2","Q4","Q8","Q16"],optionals:["bitmap"]}[key]||[];items=values.map(v=>item(v,v,attrs[key]||"fieldDoc"));}else items=Object.entries(attrs).map(([a,key])=>item(a,a,key));}
 else if(/\|[^|]*$/.test(line)){const key=/([a-z_]+)\s*=\s*\w*$/.exec(line)?.[1];items=key==="binary_opt"?["guard","view","true","false","inline"].map(v=>item(v,v,"guardDoc")):key==="decompress"?["true","false"].map(v=>item(v,v,"fieldDoc")):[item("binary_opt=guard","binary_opt=guard","guardDoc"),item("decompress=true","decompress=true","fieldDoc")];}
 else{items=[...(["u8","u16","u32","u64","i8","i16","i32","i64"].map(n=>item(n,n,"fieldDoc",7))),item("str","str","boundedDoc",7),...report.structs.map(s=>item(s.name.x,s.name.x,"fieldDoc",22))];}
 return {isIncomplete:false,items};
}
module.exports={wire,frameSize,schemaHover,fieldHover,inspect,hints,completions,formula};
