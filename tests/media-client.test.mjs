import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Script} from 'node:vm';
import {zipFromFiles,crc32} from '../dashboard/media-client.mjs';
test('download ZIP opens in an independent ZIP reader with original bytes, safe paths and valid CRCs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pf-zip-'));
 try{
  const photo=await readFile(new URL('../exterior-before.png',import.meta.url));
  const blob=zipFromFiles([{name:'../image.png',bytes:photo},{name:'second.txt',bytes:new TextEncoder().encode('PremiereFlow')}]);
  await writeFile(join(dir,'photos.zip'),Buffer.from(await blob.arrayBuffer()));await writeFile(join(dir,'expected.png'),photo);
  const output=execFileSync('python3',['-c',"import zipfile,sys,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/'photos.zip'); assert z.testzip() is None; assert z.namelist()==['.._image.png','second.txt']; assert z.read('.._image.png')==(p/'expected.png').read_bytes(); assert z.read('second.txt')==b'PremiereFlow'; print('ZIP PASS')",dir],{encoding:'utf8'});
  assert.equal(output.trim(),'ZIP PASS');assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('ZIP bounds stop an oversized package and dashboard inline scripts remain valid JavaScript',async()=>{
 assert.throws(()=>zipFromFiles([]));assert.throws(()=>zipFromFiles(Array.from({length:11},()=>({name:'x',bytes:new Uint8Array(1)}))));
 assert.throws(()=>zipFromFiles([{name:'large',bytes:{byteLength:120000001}}]));
 const html=await readFile(new URL('../dashboard/index.html',import.meta.url),'utf8');
 for(const [,source]of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new Script(source);
});
