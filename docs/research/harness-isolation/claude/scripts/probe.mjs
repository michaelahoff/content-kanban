const { query, createSdkMcpServer, tool, getSessionMessages } = await import(process.env.FRAMEBOARD_CLAUDE_SDK_MODULE || '/tmp/fb-live-evidence/client/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const ROOT='/tmp/fb-config-claude';
const OUT=new URL('../results/',import.meta.url).pathname;
mkdirSync(ROOT+'/raw',{recursive:true});
for(const path of ['plugin/.claude-plugin','plugin/skills/selected-guide','plugin/skills/unselected-guide','work/.claude/skills/project-unselected']) mkdirSync(ROOT+'/'+path,{recursive:true});
writeFileSync(ROOT+'/plugin/.claude-plugin/plugin.json',JSON.stringify({name:'frameboard-selected',version:'1.0.0'}));
for (const name of ['selected-guide','unselected-guide']) writeFileSync(ROOT+'/plugin/skills/'+name+'/SKILL.md',`---\nname: ${name}\ndescription: Benign ${name} sentinel for isolated configuration testing.\n---\n${name==='selected-guide'?'FB_SELECTED_GUIDANCE_SENTINEL':'FB_UNSELECTED_GUIDANCE_SENTINEL'}\nThis is nonexecuting writing guidance. Use a short sentence.\n`);
writeFileSync(ROOT+'/work/CLAUDE.md','FB_UNSELECTED_PROJECT_INSTRUCTION_SENTINEL\n');
writeFileSync(ROOT+'/work/.claude/skills/project-unselected/SKILL.md','---\nname: project-unselected\ndescription: Unselected project sentinel.\n---\nFB_UNSELECTED_PROJECT_SKILL_SENTINEL\n');
writeFileSync(ROOT+'/work/.claude/settings.json',JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:`printf project-hook >> ${ROOT}/project-hooks.log`}]}]},permissions:{allow:['Bash(*)']}}));
const timeout=(p,ms=90000)=>Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),ms))]);
export const BASE={pathToClaudeCodeExecutable:'/usr/bin/claude',cwd:ROOT+'/work',model:'sonnet',settingSources:[],strictMcpConfig:true,mcpServers:{},plugins:[{type:'local',path:ROOT+'/plugin'}],skills:['frameboard-selected:selected-guide'],tools:['Skill'],settings:{disableClaudeAiConnectors:true,syncClaudeAiSkills:false,syncClaudeAiPlugins:false,autoMemoryEnabled:false,disableAllHooks:true,disableBundledSkills:true},systemPrompt:{type:'custom',prompt:'FB_SELECTED_DEVELOPER_SENTINEL\nYou are testing benign isolated configuration. Selected skill guidance: FB_SELECTED_GUIDANCE_SENTINEL. Use a short sentence.',snapshot:false},maxTurns:3,includePartialMessages:true,canUseTool:async()=>({behavior:'deny',message:'No unselected actions allowed.'})};
export function open(label,options={}){
  const queue=[];let wake,closed=false;const messages=[];const waiters=[];
  async function* input(){while(!closed){if(queue.length){yield queue.shift();continue;}await new Promise(r=>wake=r);wake=null;}}
  const q=query({prompt:input(),options:{...BASE,...options,stderr:data=>appendFileSync(ROOT+'/raw/'+label+'.stderr',data)}});
  const pump=(async()=>{try{for await(const m of q){messages.push(m);appendFileSync(ROOT+'/raw/'+label+'.jsonl',JSON.stringify(m)+'\n');for(const f of [...waiters])f(m);}}catch(e){messages.push({type:'pump_error',error:String(e)});for(const f of [...waiters])f(messages.at(-1));}})();
  const wait=(pred,ms=90000)=>timeout(new Promise(resolve=>{const f=m=>{if(pred(m)){waiters.splice(waiters.indexOf(f),1);resolve(m);}};waiters.push(f);}),ms);
  const send=text=>queue.push({type:'user',message:{role:'user',content:text},parent_tool_use_id:null})&&wake?.();
  async function turn(text){const done=wait(m=>m.type==='result'||m.type==='pump_error');send(text);return done;}
  async function inspect(){const init=await timeout(q.initializationResult());const ctx=await timeout(q.getContextUsage({detail:'summary'}));const commands=await q.supportedCommands();const mcp=await q.mcpServerStatus();return {initKeys:Object.keys(init),commands:commands.filter(c=>c.name.includes('selected')||c.name.includes('unselected')).map(c=>({name:c.name,description:c.description})),context:{memoryFiles:ctx.memoryFiles.map(f=>({path:f.path.replace(ROOT,'SCRATCH'),type:f.type,tokens:f.tokens})),skills:ctx.skills,systemTools:ctx.systemTools,deferredBuiltinTools:ctx.deferredBuiltinTools,mcpTools:ctx.mcpTools.map(t=>({name:t.name,serverName:t.serverName,tokens:t.tokens,isLoaded:t.isLoaded})),systemPromptSections:ctx.systemPromptSections},mcp:mcp.map(s=>({name:s.name,type:s.type,status:s.status,tools:s.tools?.map(t=>t.name)})),initSelected:JSON.stringify(init).includes('selected-guide'),initUnselected:JSON.stringify(init).includes('unselected-guide')};}
  async function close(){closed=true;wake?.();q.close();await Promise.race([pump,new Promise(r=>setTimeout(r,2000))]);}
  return {q,messages,turn,send,wait,inspect,close};
}
export function save(name,data){writeFileSync(OUT+'/'+name+'.json',JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({name,...data}));}
export function sanitizeMessages(messages){return messages.map(m=>m.type==='system'&&m.subtype==='init'?{type:m.type,subtype:m.subtype,session_id:m.session_id,tools:m.tools,mcp_servers:m.mcp_servers,skills:m.skills,permissionMode:m.permissionMode}:m.type==='assistant'?{type:m.type,session_id:m.session_id,uuid:m.uuid,content:m.message.content.filter(b=>b.type!=='thinking')}:m.type==='user'?{type:m.type,session_id:m.session_id,content:m.message.content}:m.type==='result'?{type:m.type,session_id:m.session_id,subtype:m.subtype,is_error:m.is_error,num_turns:m.num_turns,total_cost_usd:m.total_cost_usd,stop_reason:m.stop_reason}: {type:m.type,subtype:m.subtype,session_id:m.session_id,error:m.error});}
if (process.argv[2]==='init') {const s=open('init');try{save('init',await s.inspect());}finally{await s.close();}process.exit();}
