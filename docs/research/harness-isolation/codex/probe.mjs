// Installed-harness probe with a credential-free loopback Responses fixture.
// Never persists request bodies, headers, account data, or global config.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
const root=mkdtempSync('/tmp/frameboard-codex-isolation-');
writeFileSync(root+'/AGENTS.md','FB_UNSELECTED_REPO_INSTRUCTION_SENTINEL');
mkdirSync(root+'/.agents/skills/fb-selected',{recursive:true});
const skillPath=root+'/.agents/skills/fb-selected/SKILL.md';
writeFileSync(skillPath,'---\nname: fb-selected\ndescription: A benign selected fixture.\n---\nFB_SELECTED_SKILL_GUIDANCE_SENTINEL\n');
writeFileSync(root+'/fixture.txt','FB_BENIGN_FILE_SENTINEL');
const captured=[];let injection=null;
function toolNames(ts){return (ts??[]).flatMap(t=>t.type==='namespace'?(t.tools??[]).map(x=>t.name+'.'+x.name):[t.name??t.type]);}
const peer=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;let body;try{body=JSON.parse(raw)}catch{res.writeHead(404);res.end();return}
 const serial=JSON.stringify(body);captured.push({path:req.url,authorizationPresent:!!req.headers.authorization,bodyKeys:Object.keys(body),inputItemTypes:(body.input??[]).map(x=>x.type),tools:toolNames(body.tools),additionalToolNames:(body.input??[]).filter(x=>x.type==='additional_tools').flatMap(x=>toolNames(x.tools)),codeModeTools:[...serial.matchAll(/declare const tools: \{ (\w+)\(/g)].map(x=>x[1]),selectedInstruction:serial.includes('FB_SELECTED_INSTRUCTION_SENTINEL'),repoInstruction:serial.includes('FB_UNSELECTED_REPO_INSTRUCTION_SENTINEL'),selectedSkillGuidance:serial.includes('FB_SELECTED_SKILL_GUIDANCE_SENTINEL'),replacementInstruction:serial.includes('FB_REPLACEMENT_INSTRUCTION_SENTINEL'),toolRejectionPresent:(body.input??[]).filter(x=>(x.type==='function_call_output'||x.type==='custom_tool_call_output')).some(x=>/unknown tool|unsupported|not found/i.test(JSON.stringify(x))),nativeSummaryMarker:serial.includes('FB_NATIVE_SOURCE_SENTINEL'),fileSentinelReturned:(body.input??[]).filter(x=>(x.type==='function_call_output'||x.type==='custom_tool_call_output')).some(x=>JSON.stringify(x).includes('FB_BENIGN_FILE_SENTINEL')),clientMetadataKeys:Object.keys(body.client_metadata??{}),toolOutputKinds:(body.input??[]).filter(x=>['function_call_output','custom_tool_call_output'].includes(x.type)).map(x=>({type:x.type,unknown:JSON.stringify(x).includes('not a function')||/unknown tool|unsupported|not found/i.test(JSON.stringify(x)),syntax:JSON.stringify(x).includes('SyntaxError'),containsFixture:JSON.stringify(x).includes('FB_BENIGN_FILE_SENTINEL')}))});
 res.writeHead(200,{'Content-Type':'text/event-stream'});const id='resp_fb_'+captured.length;
 const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
 emit('response.created',{response:{id,object:'response',status:'in_progress',output:[]}});
 const call=injection;injection=null;
 const item=call?{type:'custom_tool_call',id:'fc_fb_'+captured.length,call_id:'call_fb_'+captured.length,name:call.name,input:call.arguments.code}:{id:'msg_fb_'+captured.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'FB_FIXTURE_RESPONSE',annotations:[]}]};
 emit('response.output_item.added',{output_index:0,item:call?{...item,input:''}:{...item,content:[]}});
 if(call)emit('response.custom_tool_call_input.delta',{output_index:0,item_id:item.id,delta:item.input});else {emit('response.content_part.added',{output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:'FB_FIXTURE_RESPONSE'});}
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:{id,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
});await new Promise(r=>peer.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${peer.address().port}/v1`;
const overrides=['features.apps=false','features.plugins=false','features.hooks=false','features.shell_snapshot=false','features.remote_models=false','notify=[]',`model_providers.fb_fixture={name="Frameboard fixture",base_url="${base}",requires_openai_auth=false,wire_api="responses",supports_websockets=false,request_max_retries=0,stream_max_retries=0}`];
const child=spawn('codex',['app-server',...overrides.flatMap(v=>['-c',v])],{cwd:root,stdio:['pipe','pipe','pipe']});
const pending=new Map(),listeners=new Set();let seq=1;const notifications=[];
createInterface({input:child.stderr}).on('line',()=>{});
createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
 if(m.id!==undefined&&!m.method){let p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}else if(m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,result:{decision:'decline'}})+'\n')}else{notifications.push(m);for(const l of listeners)l(m)}});
function rpc(method,params){const id=seq++;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout: '+method))},30000);pending.set(id,{resolve:x=>{clearTimeout(timeout);resolve(x)},reject:x=>{clearTimeout(timeout);reject(x)}});child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
async function turn(threadId,label,input,extra={}){let before=captured.length;let events=[];const l=m=>{if(m.params?.threadId===threadId)events.push(m)};listeners.add(l);const start=await rpc('turn/start',{threadId,input,effort:'low',...extra});await new Promise((r,j)=>{const timer=setTimeout(()=>{listeners.delete(done);j(Error('turn timeout'))},30000);const done=m=>{if(m.method==='turn/completed'&&m.params?.threadId===threadId&&m.params.turn.id===start.turn.id){clearTimeout(timer);listeners.delete(done);r()}};listeners.add(done)});listeners.delete(l);return {label,status:events.find(e=>e.method==='turn/completed')?.params.turn.status,requests:captured.slice(before),itemTypes:[...new Set(events.filter(e=>e.method==='item/completed').map(e=>e.params.item.type))],error:events.find(e=>e.method==='error')?.params.error?.message??null}}
const text=s=>[{type:'text',text:s}];const result={installedVersion:'codex-cli 0.160.1',inference:'credential-free loopback mock Responses',cases:[]};
try{
 await rpc('initialize',{clientInfo:{name:'frameboard-isolation-probe',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const cfg=await rpc('config/read',{includeLayers:true,cwd:root});result.layerTypes=cfg.layers?.map(l=>l.name?.type??l.name??l.metadata?.source?.type??Object.keys(l));
 const mcps=Object.keys(cfg.config.mcp_servers??{});result.inheritedMcpCount=mcps.length;
 const common={'features.tool_registry.turn_metadata_includes_tool_info':true,'project_doc_max_bytes':0,'features.plugins':false,'features.apps':false,'features.hooks':false,'features.skip_host_skill_discovery':true,'skills.bundled.enabled':false,'cloud.skills.enabled':false,'web_search':'disabled','features.image_generation':false,'features.code_mode':false,'features.code_mode_only':false,'features.multi_agent':false,'features.multi_agent_v2':false,'features.current_time_reminder':false,'features.sleep_tool':false,'features.token_budget':false,'features.send_message_to_user_async':false,'tools.update_plan.enabled':false,'tools.experimental_request_user_input':{enabled:false},'notify':[]};
 for(const m of mcps)common['mcp_servers.'+m+'.enabled']=false;
 const sk=await rpc('skills/list',{cwds:[root],forceReload:true});const allSkills=sk.data?.flatMap(x=>x.skills??[])??[];result.discoveredSkillCount=allSkills.length;common['features.skip_host_skill_discovery']=false;common['skills.config']=allSkills.map(x=>({path:x.path,enabled:x.path===skillPath}));
 result.controls=Object.keys(common).filter(x=>!x.startsWith('mcp_servers.'));result.mcpServerDisableCount=mcps.length;
 const primary=await rpc('thread/start',{cwd:root,model:'gpt-6-luna',modelProvider:'fb_fixture',config:common,developerInstructions:'FB_SELECTED_INSTRUCTION_SENTINEL',sandbox:'read-only',approvalPolicy:'never',dynamicTools:[{type:'function',name:'fb_selected_tool',description:'Benign selected fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
 const p=primary.thread.id;result.primaryIdentity=p;
 injection={name:'exec',arguments:{code:"text(await tools.exec_command({cmd:'cat fixture.txt'}))"}};
 result.cases.push(await turn(p,'primary selected guidance/catalog and benign nested shell',text('FB_NATIVE_SOURCE_SENTINEL. Read fixture.' )));
 const before=await rpc('thread/read',{threadId:p,includeTurns:true});
 const summary=await rpc('thread/start',{cwd:root,model:'gpt-6-luna',modelProvider:'fb_fixture',config:{...common,'features.shell_tool':false,'features.view_image':false,'features.search_tool':false},developerInstructions:'FB_SELECTED_INSTRUCTION_SENTINEL',sandbox:'read-only',approvalPolicy:'never',dynamicTools:[],environments:[],selectedCapabilityRoots:[],ephemeral:true});
 const s=summary.thread.id;result.summaryIdentity=s;
 result.cases.push(await turn(s,'summary retains selected text skill but requests no optional capabilities',[...text('Summarize frozen source: FB_NATIVE_SOURCE_SENTINEL'),{type:'skill',name:'fb-selected',path:skillPath}]));
 injection={name:'exec',arguments:{code:"text(await tools.exec_command({cmd:'cat fixture.txt'}))"}};
 result.cases.push(await turn(s,'summary forced forbidden shell call',text('Probe native registration.')));
 const after=await rpc('thread/read',{threadId:p,includeTurns:true});result.primaryHistoryAndMetadataUnchanged=JSON.stringify(before)===JSON.stringify(after);result.primaryTurnCountBefore=before.thread.turns.length;result.primaryTurnCountAfter=after.thread.turns.length;
 const resumed=await rpc('thread/resume',{threadId:p,config:{...common,'features.shell_tool':false},developerInstructions:'FB_REPLACEMENT_INSTRUCTION_SENTINEL',excludeTurns:true});
 result.resumeReturnsSameIdentity=resumed.thread.id===p;result.cases.push(await turn(p,'warm resume override test',text('Say fixture.')));
 result.warnings=notifications.filter(n=>n.method==='configWarning').map(n=>({message:n.params?.message?.replaceAll(root,'<scratch>')}));
}catch(e){result.error=e.message}
finally{child.kill('SIGKILL');await new Promise(r=>peer.close(r));writeFileSync(resolve('docs/research/harness-isolation/codex/results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))}
