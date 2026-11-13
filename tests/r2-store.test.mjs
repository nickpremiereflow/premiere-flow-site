import test from 'node:test';
import assert from 'node:assert/strict';
import {r2Store} from '../server/r2-store.mjs';
const env={PF_R2_ACCOUNT_ID:'a'.repeat(32),PF_R2_BUCKET:'premiereflow-preview-media',PF_R2_ACCESS_KEY_ID:'b'.repeat(32),PF_R2_SECRET_ACCESS_KEY:'test-only-not-a-real-secret-1234567890',VERCEL_ENV:'preview'};
const key='v1/preview/a0000000-0000-4000-8000-000000000001';
test('R2 upload capability is scoped, short lived and cannot overwrite verified objects',async()=>{
 const r2=r2Store(env,{now:()=>Date.parse('2026-11-12T00:00:00Z')});
 const a=await r2.upload(key,{mime:'image/jpeg',bytes:2048});const u=new URL(a.url);
 assert.equal(u.origin,'https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com');
 assert.equal(u.pathname,'/premiereflow-preview-media/'+key);
 assert.equal(u.searchParams.get('X-Amz-Expires'),'300');
 assert.equal(u.searchParams.get('X-Amz-SignedHeaders'),'content-length;content-type;host;if-none-match');
 assert.equal(a.headers['if-none-match'],'*');assert.equal(a.headers['content-length'],'2048');
 assert.equal(a.headers['content-type'],'image/jpeg');assert.equal(a.expiresAt,Date.parse('2026-11-12T00:05:00Z'));
 assert.equal(u.searchParams.get('X-Amz-Signature').length,64);
 assert.notEqual(a.url,(await r2.upload(key,{mime:'image/png',bytes:2048})).url);
 assert.notEqual(a.url,(await r2.upload(key,{mime:'image/jpeg',bytes:2049})).url);
 assert.ok(!a.url.includes(env.PF_R2_SECRET_ACCESS_KEY));
});
test('R2 rejects arbitrary hosts, cross-environment paths, traversal and unsafe upload types',async()=>{
 const r2=r2Store(env);
 for(const bad of ['https://attacker.test/x','../x','v1/production/a0000000-0000-4000-8000-000000000001',key+'?x=1',key+'/../../x'])await assert.rejects(r2.upload(bad,{mime:'image/jpeg',bytes:12}));
 for(const p of [{mime:'image/svg+xml',bytes:12},{mime:'text/html',bytes:12},{mime:'image/jpeg',bytes:0},{mime:'image/jpeg',bytes:30000001}])await assert.rejects(r2.upload(key,p));
 assert.throws(()=>r2Store({...env,PF_R2_ACCOUNT_ID:'attacker.test/path'}));
});
test('R2 signed downloads sanitize filenames and do not make the bucket public',async()=>{
 const a=await r2Store(env).download(key,{attachment:true,filename:'../../bad\r\nSet-Cookie:x.jpg'});
 const u=new URL(a.url);assert.equal(u.searchParams.get('X-Amz-Expires'),'300');
 assert.ok(!u.searchParams.get('response-content-disposition').includes('\n'));
 assert.equal(u.searchParams.get('X-Amz-SignedHeaders'),'host');
});
test('R2 verification makes authenticated bounded reads and fails closed',async()=>{
 const calls=[];const r2=r2Store(env,{fetcher:async(request,options)=>{calls.push({request,options});return new Response(Buffer.from('image'),{headers:{'content-type':'image/jpeg','content-length':'5','etag':'"immutable"'}});}});
 assert.deepEqual(await r2.head(key),{bytes:5,mime:'image/jpeg',etag:'"immutable"'});
 assert.equal((await r2.read(key,{maxBytes:10})).body.toString(),'image');
 assert.match(calls[0].request.headers.get('authorization'),/^AWS4-HMAC-SHA256 /);assert.equal(calls[0].options.redirect,'error');
 await assert.rejects(r2.read(key,{maxBytes:3}),e=>e.code==='UPLOAD_INVALID');
 await assert.rejects(r2Store(env,{fetcher:async()=>new Response('',{status:404})}).head(key),e=>e.code==='UPLOAD_PENDING');
 await assert.rejects(r2Store(env,{fetcher:async()=>new Response('',{status:500})}).head(key),e=>e.code==='STORAGE_UNAVAILABLE');
});
test('R2 enforces the byte cap even when Content-Length is missing',async()=>{
 const response=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(6));c.enqueue(new Uint8Array(6));c.close();}}),{headers:{'content-type':'image/jpeg'}});
 await assert.rejects(r2Store(env,{fetcher:async()=>response()}).read(key,{maxBytes:10}),e=>e.code==='UPLOAD_INVALID');
});
