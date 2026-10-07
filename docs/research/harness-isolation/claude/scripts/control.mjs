// Read-only control observations of the typed stream-json protocol; no model prompt.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,readFileSync,appendFileSync} from 'node:fs';
const ROOT='/tmp/fb-config-claude';
const OUT=new URL('../results/',import.meta.url).pathname;
const cases=[['baseline',{}],['selected-hook-enabled',{disableAllHooks:false}],['selected-hook-disabled',{disableAllHooks:true}]];
const observations=[];
for(const [label,overlay] of cases){
 const marker=ROOT+'/'+label+'.hook-marker';
 const settings={disableClaudeAiConnectors:true,syncClaudeAiSkills:false,syncClaudeAiPlugins:false,autoMemoryEnabled:false,disableBundledSkills:true,disableAllHooks:true,...overlay,hooks:{SessionStart:[{hooks:[{type:'command',command:`printf selected-hook >> ${marker}`}]}]}};
 const child=spawn('/usr/bin/claude',['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--settings',JSON.stringify(settings),'--model','sonnet'],{cwd:ROOT+'/work',stdio:['pipe','pipe','pipe']});
 let line='';const pending=new Map(); const raw=ROOT+'/raw/control-'+label+'.jsonl';
 child.stdout.on('data',data=>{line+=data;const lines=line.split('\n');line=lines.pop();for(const row of lines){appendFileSync(raw,row+'\n');try{const msg=JSON.parse(row);if(msg.type==='control_response'){const r=msg.response;pending.get(r.request_id)?.(r);pending.delete(r.request_id);}}catch{}}});
 child.stderr.on('data',data=>appendFileSync(ROOT+'/raw/control-'+label+'.stderr',data));
 const call=(id,request)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('timeout '+id)),20000);pending.set(id,r=>{clearTimeout(t);resolve(r);});child.stdin.write(JSON.stringify({type:'control_request',request_id:id,request})+'\n');});
 try{
  await call('initialize',{subtype:'initialize',hooks:{}});
  const hr=await call('hooks',{subtype:'get_hooks_listing'});
  const sr=await call('settings',{subtype:'get_settings'});
  const h=hr.response;
  const settingsData=sr.response;
  writeFileSync(ROOT+'/raw/settings-'+label+'.json',JSON.stringify(settingsData));
  const keys=['disableClaudeAiConnectors','syncClaudeAiSkills','syncClaudeAiPlugins','autoMemoryEnabled','disableBundledSkills','disableAllHooks'];
  observations.push({label,hookResponseKeys:Object.keys(h??{}),hooksPolicy:h?.policy,hookRows:h?.hooks?.map(x=>({event:x.event,source:x.source,type:x.type,disabled:x.disabled,selectedSentinel:x.commandText?.includes(marker)})),settingsResponseKeys:Object.keys(settingsData??{}),effectiveControls:Object.fromEntries(keys.map(k=>[k,settingsData?.effective?.[k]])),selectedSettingsObserved:JSON.stringify(settingsData).includes('disableAllHooks'),markerPresent:existsSync(marker),hookError:hr.error,settingsError:sr.error});
 }catch(e){observations.push({label,error:String(e)});}finally{child.stdin.end();child.kill();}
}
writeFileSync(OUT+'/control-hooks.json',JSON.stringify(observations,null,2)+'\n');console.log(JSON.stringify(observations,null,2));
