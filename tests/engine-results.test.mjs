import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {engineResult,engineResults} from '../server/engine-results.mjs';
import {canonical,digest} from '../server/repository.mjs';

const id='c0000000-0000-4000-8000-000000000010',token='r'.repeat(43);
const url='https://5zzyp2gsg2.ucarecd.net/c0000000-0000-4000-8000-000000000010~1/';
const complete={jobId:id,attempt:1,status:'COMPLETED',outputUrl:url,qaStatus:'PASS'};
const failure={jobId:id,attempt:1,status:'RETRY_REQUIRED',qaStatus:'FAIL',errorStage:'Gemini',errorCode:'429',errorDetails:'Try later',nextRetryAt:'2026-11-10T18:00:00Z'};
const png=await readFile(new URL('../exterior-before.png',import.meta.url));
function fixture({context={expectedImages:1,status:'PROCESSING'},response={status:200,headers:{'content-type':'image/png'},body:png},dbError}={}) {
 const writes=[],reads=[],dbCalls=[];
 const database={query:async(sql,args)=>{dbCalls.push(args);if(sql.includes('pf_engine_result_context'))return {rows:[{result:context}]};writes.push(args);if(dbError)throw new Error(dbError);return {rows:[{result:{received:true,duplicate:false,jobId:id,status:JSON.parse(args[1]).status}}]};}};
 const read=async(value,options)=>{reads.push(value);await options.beforeRequest(new URL(value));return {url:value,...response};};
 return {finish:engineResults(database,{read}),writes,reads,dbCalls};
}
test('completion accepts only exact production project groups and PASS; browser identity is never accepted',()=>{
 assert.equal(engineResult(complete).outputUrl,url);
 for(const change of [{accountId:'PF-OTHER'},{attempt:0},{attempt:4},{attempt:'1'},{qaStatus:'FAIL'},{qaStatus:'PENDING'},{outputUrl:url+'nth/0/'},{outputUrl:url+'?key=value'},{outputUrl:url.replace('5zzyp2gsg2','otherproject')},{outputUrl:url.replace('https:','http:')},{errorCode:'500'}])assert.throws(()=>engineResult({...complete,...change}),{status:400});
});
test('failure preserves provider timing, redacts credentials, and bounds final retries',()=>{
 const r=engineResult({...failure,errorDetails:'Bearer private-token https://provider.example/result?key=secret rk_test_private'});
 assert.equal(r.nextRetryAt,'2026-11-10T18:00:00.000Z');
 assert.equal(r.errorDetails.includes('private'),false);assert.equal(r.errorDetails.includes('key=secret'),false);
 assert.equal(engineResult({...failure,attempt:3}).status,'FAILED');assert.equal(engineResult({...failure,attempt:3}).nextRetryAt,null);
 for(const change of [{qaStatus:'PASS'},{outputUrl:url},{nextRetryAt:'tomorrow'},{errorStage:''},{errorCode:''}])assert.throws(()=>engineResult({...failure,...change}),{status:400});
});
test('unauthorized or stale attempts stop before any image access or result write',async()=>{
 const f=fixture({context:null});await assert.rejects(f.finish(token,complete),{status:403});assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
 await assert.rejects(f.finish('bad',complete),{status:403});assert.equal(f.dbCalls.length,1);assert.equal(f.dbCalls[0][0],digest(token));
});
test('only verified image bytes are persisted and URLs are bound to each output ordinal',async()=>{
 const f=fixture();assert.equal((await f.finish(token,complete)).received,true);
 assert.deepEqual(f.reads,[url+'nth/0/']);const assets=JSON.parse(f.writes[0][3]);assert.equal(assets[0].byteSize,png.length);assert.equal(assets[0].mimeType,'image/png');assert.match(assets[0].sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(f.writes).includes(token),false);
});
test('QA/output mismatch and missing, malformed or inaccessible assets cannot complete or charge',async()=>{
 const mismatch=fixture({context:{expectedImages:2,status:'PROCESSING'}});await assert.rejects(mismatch.finish(token,complete),{status:400});assert.equal(mismatch.reads.length,0);
 for(const response of [{status:404,headers:{},body:Buffer.alloc(0)},{status:200,headers:{'content-type':'text/html'},body:Buffer.from('Not an image')},{status:200,headers:{'content-type':'image/png'},body:png.subarray(0,24)},{url:'https://evil.example/image',status:200,headers:{'content-type':'image/png'},body:png}]) {
   const f=fixture({response});await assert.rejects(f.finish(token,complete),{code:'ASSET_UNAVAILABLE'});assert.equal(f.writes.length,0);
 }
});
test('exact completed replay is a no-op; conflicting replay fails before reading images',async()=>{
 const context={expectedImages:1,status:'COMPLETED',resultFingerprint:digest(canonical(engineResult(complete)))};
 const f=fixture({context});assert.equal((await f.finish(token,complete)).duplicate,true);assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
 await assert.rejects(f.finish(token,{...complete,qaNotes:'changed'}),{status:409});assert.equal(f.reads.length,0);
});
test('failure uses the same atomic result operation without image fetches or new jobs',async()=>{
 const f=fixture();assert.equal((await f.finish(token,failure)).status,'RETRY_REQUIRED');assert.equal(f.reads.length,0);assert.equal(f.writes.length,1);assert.deepEqual(JSON.parse(f.writes[0][3]),[]);
 const conflict=fixture({dbError:'RESULT_CONFLICT'});await assert.rejects(conflict.finish(token,failure),{status:409});
});
test('a storage redirect is rejected before its destination is accessed',async()=>{
 let requests=0;
 const db={query:async()=>({rows:[{result:{expectedImages:1,status:'PROCESSING'}}]})};
 const read=async(value,options)=>{requests++;await options.beforeRequest(new URL('https://other.example/secret'));throw new Error('must not reach');};
 await assert.rejects(engineResults(db,{read})(token,complete),{code:'ASSET_UNAVAILABLE'});assert.equal(requests,1);
});
