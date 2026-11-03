import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';

test('private acceptance page is built only for its Preview branch; server and secrets never become static files',()=>{
  const build=(env)=>execFileSync(process.execPath,['scripts/build-static.mjs'],{env:{...process.env,...env},stdio:'pipe'});
  build({VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/secure-customer-access'});
  assert.ok(existsSync('public/preview-checks/index.html'));
  for(const file of ['tests/preview-acceptance.html','setup/index.html','login/index.html']){
    const scripts=[...readFileSync(file,'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    for(const [,source]of scripts)new vm.Script(source,{filename:file});
  }
  build({VERCEL_ENV:'production',VERCEL_GIT_COMMIT_REF:'main'});
  for(const path of ['preview-checks','tests','server','migrations','.env'])assert.equal(existsSync('public/'+path),false,path);
});
