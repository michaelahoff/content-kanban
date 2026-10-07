import {open,save} from './probe.mjs';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const ROOT='/tmp/fb-config-claude';
mkdirSync(ROOT+'/selected-only/.claude-plugin',{recursive:true});
mkdirSync(ROOT+'/selected-only/skills/selected-guide',{recursive:true});
writeFileSync(ROOT+'/selected-only/.claude-plugin/plugin.json',JSON.stringify({name:'frameboard-staged',version:'1.0.0'}));
writeFileSync(ROOT+'/selected-only/skills/selected-guide/SKILL.md',readFileSync(ROOT+'/plugin/skills/selected-guide/SKILL.md'));
const session=open('selected-only-staging',{plugins:[{type:'local',path:ROOT+'/selected-only'}],skills:['frameboard-staged:selected-guide'],tools:['Skill']});
try{save('selected-only-staging',await session.inspect());}finally{await session.close();}
process.exit();
