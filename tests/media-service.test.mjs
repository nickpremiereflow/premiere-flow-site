import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mediaService} from '../server/media-service.mjs';
import {engineResults} from '../server/engine-results.mjs';
import {digest} from '../server/repository.mjs';
import {imagePreflight} from '../server/listing-import.mjs';
const origin='https://www.premiereflow.com',groupId='a0000000-0000-4000-8000-000000000001',jobId='b0000000-0000-4000-8000-000000000001',objectId='c0000000-0000-4000-8000-000000000001';
const token='z'.repeat(43),account={accountId:'PF-A',userId:'user-a'},url=origin+'/api/media/groups/'+groupId+'~1/';
const bytes=await readFile(new URL('../exterior-before.png',import.meta.url)),sha=createHash('sha256').update(bytes).digest('hex');
function fixture({kind='generated',groupState='sealed',state='verified',claimed=true,etag='"one"',returnedBytes=bytes,sourceUrl=url,readLegacy}={}){
 const g={group_id:groupId,account_id:'PF-A',namespace:'production',kind,state:groupState,expected_files:1,canonical_url:url,job_id:jobId,attempt:1};
 const row={object_id:objectId,group_id:groupId,account_id:'PF-A',role:kind,ordinal:0,state,declared_mime:'image/png',byte_size:bytes.length,allocated_bytes:bytes.length,sha256:sha,etag:'"one"',object_key:'v1/production/'+objectId};
 const reads=[],writes=[];
 const database={query:async(sql,args)=>{
  let result=[];
  if(sql.includes('SELECT j.*')){if(claimed&&args[0]===jobId&&args[1]===1&&args[2]===digest(token))result=[{job_id:jobId,account_id:'PF-A',expected_images:1,source_url:sourceUrl}];}
  else if(sql.includes('SELECT * FROM pf_media_group WHERE group_id')){if(args[0]===groupId&&args[1]==='PF-A'&&args[2]==='production')result=[g];}
  else if(sql.includes('SELECT * FROM pf_media_object WHERE group_id')){if(args[0]===groupId)result=kind==='source'?[row,{...row,object_id:'d0000000-0000-4000-8000-000000000001',role:'source_preview',declared_mime:'image/jpeg'}]:[row];}
  else if(sql.includes('SELECT o.*')){if(args[0]===objectId&&args[1]==='PF-A'&&kind==='logo')result=[row];}
  else if(sql.startsWith('UPDATE pf_media_object')){writes.push(args);row.state='verified';row.byte_size=args[1];row.sha256=args[2];row.etag=args[3];result=[row];}
  else throw new Error('Unexpected database operation');
  return {rows:result,rowCount:result.length};
 }};
 const store={prefix:'v1/production/',head:async key=>{reads.push(['head',key]);return {bytes:bytes.length,mime:'image/png',etag};},read:async key=>{reads.push(['read',key]);return {body:returnedBytes,mime:'image/png',etag};},download:async(key,opts)=>{reads.push(['download',key,opts]);return {url:'https://private.example.test/object?temporary=true'};}};
 return {media:mediaService(database,store,origin,{readLegacy}),reads,writes,g,row};
}
test('account A cannot sign account B storage, and URL/count tampering never reaches R2',async()=>{
 const f=fixture();
 for(const other of [{accountId:'PF-B',userId:'user-b'},{accountId:'PF-A'}])await assert.rejects(f.media.assetAccess(other,url+'nth/0/'));
 for(const bad of [url.replace('~1','~2')+'nth/0/',url+'nth/1/',url.replace(origin,'https://evil.example')+'nth/0/',url+'nth/0/?accountId=PF-A'])await assert.rejects(f.media.assetAccess(account,bad));
 assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
 assert.equal((await f.media.assetAccess(account,url+'nth/0/',{attachment:true})).url.includes('temporary'),true);
 assert.equal(f.reads.at(-1)[2].attachment,true);
});
test('unsealed and unverified packages cannot be viewed or downloaded',async()=>{
 for(const opts of [{groupState:'uploading'},{state:'allocated'}]){const f=fixture(opts);await assert.rejects(f.media.downloadManifest(account,url));assert.equal(f.reads.length,0);}
});
test('wrong, stale, mismatched-attempt and unclaimed engine tickets stop before storage access',async()=>{
 for(const input of [{ticket:'x'.repeat(43),attempt:1},{ticket:token,attempt:2},{ticket:token,attempt:4},{ticket:'bad',attempt:1}]){
  const f=fixture();await assert.rejects(f.media.engineMedia({...input,jobId,action:'sources'}));assert.equal(f.reads.length,0);
 }
 const expired=fixture({claimed:false});await assert.rejects(expired.media.verifyResult(token,{jobId,attempt:1,outputUrl:url},1));assert.equal(expired.reads.length,0);
});
test('completion verifies the exact sealed job/attempt file, and changed stored content fails',async()=>{
 const good=fixture();assert.deepEqual(await good.media.verifyResult(token,{jobId,attempt:1,outputUrl:url},1),[{ordinal:0,url:url+'nth/0/',mimeType:'image/png',byteSize:bytes.length,sha256:sha}]);
 for(const change of [{attempt:2},{job_id:'c0000000-0000-4000-8000-000000000002'},{kind:'source'},{state:'uploading'}]){
  const f=fixture();Object.assign(f.g,change);await assert.rejects(f.media.verifyResult(token,{jobId,attempt:1,outputUrl:url},1));assert.equal(f.reads.length,0);
 }
 const replaced=fixture({etag:'"changed"'});await assert.rejects(replaced.media.verifyResult(token,{jobId,attempt:1,outputUrl:url},1),{code:'MEDIA_CONFLICT'});
});
test('byte verification rejects HTML disguised as an image without marking it stored',async()=>{
 const bad=fixture({kind:'logo',state:'allocated',returnedBytes:Buffer.alloc(bytes.length,65)});
 await assert.rejects(bad.media.verifyUpload(account,objectId),{code:'UPLOAD_INVALID'});assert.equal(bad.writes.length,0);
 const good=fixture({kind:'logo',state:'allocated'});assert.equal((await good.media.verifyUpload(account,objectId)).verified,true);assert.equal(good.writes.length,1);
});
test('R2 storage verification errors never invoke completion or consume a credit',async()=>{
 const calls=[];const db={query:async(sql,args)=>{calls.push(sql);return {rows:[{result:{expectedImages:1,status:'PROCESSING'}}]};}};
 const finish=engineResults(db,{mediaBaseURL:origin,media:{verifyResult:async()=>{throw new Error('R2 unavailable');}}});
 await assert.rejects(finish(token,{jobId,attempt:1,status:'COMPLETED',outputUrl:url,qaStatus:'PASS'}));
 assert.equal(calls.length,1);assert.ok(calls[0].includes('pf_engine_result_context'));
});
test('small logos use separate dimensional checks without lowering vehicle-photo quality gate',()=>{
 const small=Buffer.from(bytes);small.writeUInt32BE(128,16);small.writeUInt32BE(64,20);
 assert.equal(imagePreflight(small,'image/png').accepted,false);
 assert.equal(imagePreflight(small,'image/png',{minLongEdge:32,minShortEdge:16,maxAspect:30}).accepted,true);
});


test('sequential source access signs each photo on demand instead of expiring the entire batch',async()=>{
 const f=fixture({kind:'source'});
 const list=await f.media.engineMedia({ticket:token,jobId,attempt:1,action:'sources'});
 assert.equal(list.files.length,1);assert.equal('sourceUrl' in list.files[0],false);assert.equal(f.reads.length,0);
 await f.media.engineMedia({ticket:token,jobId,attempt:1,action:'source',ordinal:0});
 await f.media.engineMedia({ticket:token,jobId,attempt:1,action:'source',ordinal:0});
 assert.equal(f.reads.length,2);assert.equal(f.reads[0][2].filename,'source-1.jpg');
 await assert.rejects(f.media.engineMedia({ticket:token,jobId,attempt:1,action:'source',ordinal:1}));assert.equal(f.reads.length,2);
});
test('historical source photos remain readable for the same claimed job without copying or writing them',async()=>{
 const legacy='https://5zzyp2gsg2.ucarecd.net/'+groupId+'~1/',reads=[];
 const f=fixture({sourceUrl:legacy,readLegacy:async(url,options)=>{reads.push(url);await options.beforeRequest(new URL(url));return {status:200,body:Buffer.from(JSON.stringify({files:[{uuid:objectId}]}))};}});
 const list=await f.media.engineMedia({ticket:token,jobId,attempt:1,action:'sources'});
 assert.equal(list.files[0].uuid,objectId);
 const file=await f.media.engineMedia({ticket:token,jobId,attempt:1,action:'source',ordinal:0});
 assert.equal(file.sourceUrl,'https://5zzyp2gsg2.ucarecd.net/'+objectId+'/-/preview/1920x1080/-/format/jpeg/-/quality/lightest/image.jpg');
 assert.equal(f.writes.length,0);assert.equal(f.reads.length,0);assert.equal(reads.length,2);
});
