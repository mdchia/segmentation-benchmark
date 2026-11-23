import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const dist=join(root,'dist');
function run(command,args,{env=process.env,input,quiet=false}={}) {
  const result=spawnSync(command,args,{cwd:root,env,input,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${command} failed: ${result.stderr||result.error||result.stdout}`);
  if(!quiet&&result.stdout)process.stdout.write(result.stdout);
  return result.stdout.trim();
}
if(run('git',['status','--porcelain'],{quiet:true}))throw new Error('Commit source changes before deploying.');
const source=run('git',['rev-parse','HEAD'],{quiet:true});
const remote=run('git',['remote','get-url','origin'],{quiet:true});
const match=remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
if(!match)throw new Error('Expected a GitHub origin remote.');
const repo=`${match[1]}/${match[2]}`;
const temp=await mkdtemp(join(tmpdir(),'rootfm-pages-'));
try {
  const env={...process.env,GIT_INDEX_FILE:join(temp,'index')};
  run('git',['read-tree','--empty'],{env});
  run('git',[`--work-tree=${dist}`,'add','--all','--force','--',dist],{env});
  const tree=run('git',['write-tree'],{env,quiet:true});
  const parent=spawnSync('git',['rev-parse','--verify','refs/heads/gh-pages'],{cwd:root,encoding:'utf8'});
  const args=['commit-tree',tree];
  if(parent.status===0)args.push('-p',parent.stdout.trim());
  const commit=run('git',args,{input:`Deploy RootFM benchmark from ${source}\n`,quiet:true});
  run('git',['update-ref','refs/heads/gh-pages',commit]);
  run('git',['-c','credential.helper=!gh auth git-credential','push','origin','gh-pages']);
  const existing=spawnSync('gh',['api',`repos/${repo}/pages`],{cwd:root,encoding:'utf8'});
  const method=existing.status===0?'PUT':'POST';
  run('gh',['api','--method',method,`repos/${repo}/pages`,'-f','build_type=legacy','-f','source[branch]=gh-pages','-f','source[path]=/'],{quiet:true});
  console.log(`Published source ${source} to the gh-pages branch. GitHub is building the site.`);
  console.log(run('gh',['api',`repos/${repo}/pages`,'--jq','.html_url'],{quiet:true}));
} finally {await rm(temp,{recursive:true,force:true});}
