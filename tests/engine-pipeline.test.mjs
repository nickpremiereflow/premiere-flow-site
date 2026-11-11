import test from 'node:test';
import assert from 'node:assert/strict';
import {enginePipeline} from '../server/engine-pipeline.mjs';
import {makeBridge} from '../server/make.mjs';

const account={userId:'controlled-user',accountId:'controlled-account',email:'controlled@example.com'};
const jobId='c0000000-0000-4000-8000-000000000008';
const input={action:'submit',jobId,vehicleName:'Controlled vehicle',showroomColor:'White (default)',logoPlacement:'No Logo',thumbnail:'',uploadcareUrl:'https://5zzyp2gsg2.ucarecd.net/'+jobId+'~1/'};
const token='a'.repeat(43);

function fixture({owned=false,transportFailure=false,uploadFailure=false,status='ACCEPTED',notification=null,job=null,emailFailure=false}={}) {
 const calls=[];
 const query=async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('pf_enqueue_engine')) return {rows:[{result:{jobId,status,attempt:1}}]};
  if(sql.includes('pf_engine_result_context')) return {rows:[{result:{resultFingerprint:'committed'}}]};
  if(sql.includes("SET state='running'")) return {rows:notification?[notification]:[]};
  if(sql.includes('SELECT j.*,u.email')) return {rows:job?[job]:[]};
  return {rows:[]};
 };
 const database={query,connect:async()=>({query,release(){}})};
 const bridge=async(audience,payload)=>{
  calls.push({audience,payload});
  if(transportFailure||emailFailure) throw Error('Connection unavailable');
  return {delivery:'sent',messageId:'controlled-message'};
 };
 const uploads={group:async()=>{calls.push({upload:true});if(uploadFailure)throw Error('Unowned source');}};
 const accounts={findOwned:async()=>owned};
 return {calls,pipeline:enginePipeline({database,accounts,bridge,uploads,baseURL:'https://controlled.example',acceptanceAccount:account.accountId})};
}

test('unowned uploads cannot reserve a credit or reach the engine',async()=>{
 const {pipeline,calls}=fixture({uploadFailure:true});
 await assert.rejects(pipeline.submit(account,input),/Unowned source/);
 assert.deepEqual(calls,[{upload:true}]);
});

test('the Preview allowlist rejects a different customer before reads or writes',async()=>{
 const {pipeline,calls}=fixture();
 await assert.rejects(pipeline.submit({...account,accountId:'another-account'},input),e=>e.status===503);
 assert.equal(await pipeline.claim(token,{accountId:'another-account'}),null);
 assert.deepEqual(calls,[]);
});

test('lost transport acknowledgement keeps the accepted job and its identity durable',async()=>{
 const {pipeline,calls}=fixture({transportFailure:true});
 assert.deepEqual(await pipeline.submit(account,input),{success:true,jobId,status:'ACCEPTED',attempt:1});
 assert.equal(calls.filter(c=>c.sql?.includes('pf_enqueue_engine')).length,1);
 assert.equal(calls.filter(c=>c.audience==='engine').length,1);
 assert.equal(calls.find(c=>c.audience==='engine').payload.jobId,jobId);
 assert.ok(calls.some(c=>c.sql?.includes('engine.awaiting_claim')));
 assert.equal(calls.some(c=>c.sql?.includes('DELETE')||c.sql?.includes('release')),false);
});

test('a known completed job is acknowledged without upload revalidation or generation',async()=>{
 const {pipeline,calls}=fixture({owned:true,status:'COMPLETED'});
 const result=await pipeline.submit(account,input);
 assert.equal(result.status,'COMPLETED');
 assert.equal(calls.some(c=>c.upload||c.audience),false);
});

test('same-job retry uses the stored sources and never accepts replacement sources',async()=>{
 const {pipeline,calls}=fixture({owned:true,status:'RETRYING'});
 await pipeline.submit(account,{action:'retry',jobId,expectedAttempt:1});
 assert.equal(calls.some(c=>c.upload),false);
 assert.equal(calls.find(c=>c.audience==='engine').payload.uploadcareUrl,'');
 await assert.rejects(pipeline.submit(account,{action:'retry',jobId,expectedAttempt:1,uploadcareUrl:input.uploadcareUrl}),e=>e.status===400);
});

test('notification replay without a lease sends no second email',async()=>{
 const {pipeline,calls}=fixture();
 assert.deepEqual(await pipeline.notifyResult(token,jobId,1),{delivered:false});
 assert.equal(calls.some(c=>c.audience),false);
});

test('completed email uses a stable message identity and escapes vehicle text',async()=>{
 const notification={command_id:'job-result:'+jobId+':1',account_id:account.accountId,payload:{jobId,attempt:1,status:'COMPLETED'}};
 const job={attempt_count:1,status:'COMPLETED',email:account.email,vehicle_name:'<img src=x onerror=alert(1)>'};
 const {pipeline,calls}=fixture({notification,job});
 assert.deepEqual(await pipeline.notifyResult(token,jobId,1),{delivered:true});
 const message=calls.find(c=>c.audience==='services').payload;
 assert.equal(message.commandId,notification.command_id);
 assert.equal(message.email,account.email);
 assert.ok(message.html.includes('&lt;img'));
 assert.ok(message.html.includes('https://controlled.example/dashboard/'));
 assert.ok(calls.some(c=>c.args?.[1]?.messageId==='controlled-message'));
});

test('email failure queues a retry without changing completion or customer credits',async()=>{
 const notification={account_id:account.accountId,payload:{jobId,attempt:1,status:'COMPLETED'}};
 const job={attempt_count:1,status:'COMPLETED',email:account.email,vehicle_name:'Vehicle'};
 const {pipeline,calls}=fixture({notification,job,emailFailure:true});
 assert.deepEqual(await pipeline.notifyResult(token,jobId,1),{delivered:false,pending:true});
 assert.ok(calls.some(c=>c.sql?.includes("retry_at=now()+interval '5 minutes'")));
 assert.equal(calls.some(c=>/UPDATE pf_job|pf_credit|pf_enqueue/.test(c.sql||'')),false);
});

test('engine callback identity is transport-only and excluded from the ticket payload',async()=>{
 let stored,wire;
 const identity='private-transport-identity-'.repeat(3);
 const repository={issueTicket:async(audience,payload)=>{stored=payload;return {send:true,token};}};
 const bridge=makeBridge(repository,{engine:'https://hook.us2.make.com/controlled'},async(url,options)=>{
  wire=JSON.parse(options.body);return new Response('Accepted');
 },{engineCallbackAuthorization:async()=>identity});
 const result=await bridge('engine',{accountId:account.accountId,jobId,action:'submit'},{acceptedOnly:true});
 assert.equal(result.jobId,jobId);
 assert.equal(wire.callbackOidcToken,identity);
 assert.equal(JSON.stringify(stored).includes(identity),false);
 assert.equal(JSON.stringify(result).includes(identity),false);
});
