import {open,BASE,save,sanitizeMessages} from './probe.mjs';
const {getSessionMessages} = await import(process.env.FRAMEBOARD_CLAUDE_SDK_MODULE || '/tmp/fb-live-evidence/client/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const ROOT='/tmp/fb-config-claude';
const OUT=new URL('../results/',import.meta.url).pathname;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const original=JSON.parse(readFileSync(OUT+'/primary-summary.json')).primaryId;
const p=readFileSync(ROOT+'/raw/primary.jsonl','utf8').trim().split('\n').map(JSON.parse);
const filter=JSON.parse(readFileSync(OUT+'/skill-filter.json'));
filter.nativeToolResults=p.filter(m=>m.type==='user').map(m=>({type:m.type,content:m.message.content}));
writeFileSync(OUT+'/skill-filter.json',JSON.stringify(filter,null,2)+'\n');
const before=await getSessionMessages(original,{dir:ROOT+'/work'});
const override=open('destination-override',{tools:['Read'],skills:[],plugins:[],hooks:{},mcpServers:{},permissionMode:'default',systemPrompt:{type:'custom',prompt:'FB_DESTINATION_DEVELOPER_SENTINEL\nUse one short sentence.',snapshot:false}});
try {const config=await override.inspect();await override.turn('Reply DESTINATION_OVERRIDE in one short sentence without tools.');const after=await getSessionMessages(original,{dir:ROOT+'/work'});save('destination-override',{inspection:config,events:sanitizeMessages(override.messages),primaryUnchanged:hash(before)===hash(after),primaryBeforeHash:hash(before),primaryAfterHash:hash(after),samePrimaryId:original});}finally{await override.close();}
const observations=[];
for(const [label,options] of [['empty-sources-inherit-connectors',{tools:{type:'preset',preset:'claude_code'},strictMcpConfig:false,settings:{...BASE.settings,disableClaudeAiConnectors:false}}],['strict-suppresses-connectors',{tools:{type:'preset',preset:'claude_code'},strictMcpConfig:true,settings:{...BASE.settings,disableClaudeAiConnectors:false}}],['disable-setting-suppresses-connectors',{tools:{type:'preset',preset:'claude_code'},strictMcpConfig:false,settings:{...BASE.settings,disableClaudeAiConnectors:true}}]]){
 const s=open(label,{...options,skills:[],plugins:[],hooks:{}});try{const i=await s.inspect();observations.push({label,mcpServerCount:i.mcp.length,mcpToolCount:i.context.mcpTools.length,accountConnectorServerCount:i.mcp.filter(x=>x.name!=='selected').length,memoryFileCount:i.context.memoryFiles.length});}finally{await s.close();}
}
save('connector-suppression',{observations});
process.exit();
