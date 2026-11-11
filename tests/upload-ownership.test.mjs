import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadOwnership} from '../server/upload-ownership.mjs';

const secret='controlled-test-secret-not-a-real-production-credential';
const a={accountId:'PF-A',userId:'user-a'},b={accountId:'PF-B',userId:'user-b'};
const idA='a0000000-0000-4000-8000-000000000001',idB='b0000000-0000-4000-8000-000000000001';
const groupId='c0000000-0000-4000-8000-000000000001~2';
const cdn='https://5zzyp2gsg2.ucarecd.net';

function fixture(){
  let time=Date.now(),failure=false;
  const files=new Map(),calls=[];
  const group={id:groupId,files_count:2,files:[{uuid:idA},{uuid:idB}]};
  const service=uploadOwnership(secret,{now:()=>time,fetcher:async(url,options)=>{
    assert.equal(url.origin,'https://upload.uploadcare.com');
    assert.equal(url.searchParams.get('pub_key'),'64387322e1e85c547e9c');
    assert.equal(options.redirect,'error');calls.push(url.href);
    if(failure)return new Response('provider unavailable',{status:503});
    return Response.json(url.pathname==='/group/info/'?group:files.get(url.searchParams.get('file_id')));
  }});
  const owned=(id,account)=>({uuid:id,is_image:true,is_ready:true,is_stored:true,size:1024,mime_type:'image/jpeg',metadata:service.issue(account).metadata});
  files.set(idA,owned(idA,a));files.set(idB,owned(idB,a));
  return {service,files,group,calls,owned,advance:ms=>time+=ms,fail:()=>failure=true};
}

test('upload proofs bind server identity, expire and reveal neither customer email nor account ID',()=>{
  const f=fixture(),proof=f.service.issue(a).metadata.pf_owner;
  assert.equal(f.service.matches(a,proof),true);
  assert.equal(f.service.matches(b,proof),false);
  assert.equal(f.service.matches({...a,userId:'other'},proof),false);
  assert.equal(f.service.matches(a,proof.slice(0,-1)+(proof.endsWith('A')?'B':'A')),false);
  assert.equal(Buffer.from(proof.split('.')[0],'base64url').toString().includes('PF-A'),false);
  f.advance(4*60*60*1000+1);
  assert.equal(f.service.matches(a,proof),false);
});

test('only provider-confirmed stored images from the same account form a listing source',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.group(a,cdn+'/'+groupId+'/',cdn+'/'+idB+'/'),{uploadcareUrl:cdn+'/'+groupId+'/',thumbnail:cdn+'/'+idB+'/',fileIds:[idA,idB]});
  await assert.rejects(f.service.group(b,cdn+'/'+groupId+'/'),e=>e.code==='UPLOAD_NOT_OWNED');
  f.files.set(idB,f.owned(idB,b));
  await assert.rejects(f.service.group(a,cdn+'/'+groupId+'/'),e=>e.code==='UPLOAD_NOT_OWNED');
});

test('browser metadata, arbitrary URLs, mixed groups and foreign covers cannot establish ownership',async()=>{
  const f=fixture();
  for(const url of ['https://attacker.test/'+groupId+'/',cdn+'/'+groupId+'/?owner=PF-A','https://ucarecdn.com/'+groupId+'/']) await assert.rejects(f.service.group(a,url),e=>e.status===403);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.service.group(a,cdn+'/'+groupId+'/',cdn+'/d0000000-0000-4000-8000-000000000001/'),e=>e.status===403);
  f.group.files=[{uuid:idA},{uuid:idA}];
  await assert.rejects(f.service.group(a,cdn+'/'+groupId+'/'),e=>e.status===403);
  f.group.files=[{uuid:idA},null];
  await assert.rejects(f.service.group(a,cdn+'/'+groupId+'/'),e=>e.status===403);
});

test('removed, temporary, non-image and unbound files fail closed, including logos',async()=>{
  const f=fixture();
  assert.equal(await f.service.file(a,cdn+'/'+idA+'/'),cdn+'/'+idA+'/');
  const crop=cdn+'/'+idA+'/-/crop/200x200/10,20/-/preview/';
  assert.equal(await f.service.file(a,crop),crop);
  await assert.rejects(f.service.file(a,cdn+'/'+idA+'/-/overlay/'+idB+'/'),e=>e.status===403);
  for(const change of [{is_stored:false},{is_ready:false},{is_image:false},{metadata:{}},{uuid:idB}]) {
    f.files.set(idA,{...f.owned(idA,a),...change});
    await assert.rejects(f.service.file(a,cdn+'/'+idA+'/'),e=>e.code==='UPLOAD_NOT_OWNED');
  }
  f.fail();
  await assert.rejects(f.service.group(a,cdn+'/'+groupId+'/'),e=>e.code==='UPLOAD_UNAVAILABLE');
});
