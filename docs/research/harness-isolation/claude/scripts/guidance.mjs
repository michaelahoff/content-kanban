import {open,BASE,save,sanitizeMessages} from './probe.mjs';
const {getSessionMessages} = await import(process.env.FRAMEBOARD_CLAUDE_SDK_MODULE || '/tmp/fb-live-evidence/client/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const ROOT='/tmp/fb-config-claude';
const OUT=new URL('../results/',import.meta.url).pathname;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const primaryId=JSON.parse(readFileSync(OUT+'/primary-summary.json')).primaryId;
const guidance=readFileSync(ROOT+'/plugin/skills/selected-guide/SKILL.md','utf8').replace(/^---\n[\s\S]*?\n---\n/,'');
const trace=ROOT+'/stream-trace';
writeFileSync(trace,`#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const {appendFileSync}=require('node:fs');const child=spawn('/usr/bin/claude',process.argv.slice(2),{stdio:['pipe','pipe','inherit']});let rest='';process.stdin.on('data',d=>{rest+=d;const rows=rest.split('\\n');rest=rows.pop();for(const row of rows){try{const m=JSON.parse(row);if(m.type==='control_request'&&m.request?.subtype==='initialize'){const s=JSON.stringify(m.request);appendFileSync('${ROOT}/raw/initialize-guidance.jsonl',JSON.stringify({requestKeys:Object.keys(m.request),selectedDeveloper:s.includes('FB_SELECTED_DEVELOPER_SENTINEL'),selectedGuidance:s.includes('FB_SELECTED_GUIDANCE_SENTINEL'),fullSelectedGuidance:s.includes('This is nonexecuting writing guidance. Use a short sentence.'),unselectedGuidance:s.includes('FB_UNSELECTED'),nativeSkills:m.request.skills,hookEventNames:Object.keys(m.request.hooks??{})})+'\\n');}}catch{}}});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code??1));\n`,{mode:0o755});
const before=await getSessionMessages(primaryId,{dir:ROOT+'/work'});
const summary=open('summary-full-guidance',{pathToClaudeCodeExecutable:trace,tools:[],skills:[],plugins:[],hooks:{},mcpServers:{},permissionMode:'default',settings:{...BASE.settings,disableAllHooks:true},systemPrompt:{type:'custom',prompt:'FB_SELECTED_DEVELOPER_SENTINEL\nSelected skill guidance, supplied as nonexecuting context:\n'+guidance+'\nSummarize only the supplied frozen visible source in one sentence.',snapshot:false}});
try{const config=await summary.inspect();await summary.turn('Frozen source: The user asked for a remembered label, and the assistant answered PRIMARY_ALPHA. Summarize one sentence.');const after=await getSessionMessages(primaryId,{dir:ROOT+'/work'});save('summary-full-guidance',{inspection:config,events:sanitizeMessages(summary.messages),observedInitialize:readFileSync(ROOT+'/raw/initialize-guidance.jsonl','utf8').trim().split('\n').map(JSON.parse),selectedSkillGuidanceHash:hash(guidance),primaryUnchanged:hash(before)===hash(after),primaryBeforeHash:hash(before),primaryAfterHash:hash(after)});}finally{await summary.close();}
process.exit();
