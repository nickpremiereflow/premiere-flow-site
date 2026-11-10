import test from 'node:test';
import assert from 'node:assert/strict';
import {engineRecovery} from '../server/engine-recovery.mjs';

test('recovery rechecks each candidate and treats a competing completion as a no-op',async()=>{
 const rows=[{account_id:'fixture-a',job_id:'job-a',attempt:1},{account_id:'fixture-b',job_id:'job-b',attempt:2}];
 const calls=[];
 const db={query:async(sql,args)=>{calls.push({sql,args});if(!args)return {rows};return {rows:[{expired:args[1]==='job-b'}]};}};
 assert.deepEqual(await engineRecovery(db)(),{checked:2,recovered:1});
 assert.deepEqual(calls.slice(1).map(c=>c.args),[['fixture-a','job-a',1],['fixture-b','job-b',2]]);
});

test('empty recovery has no writes and database errors do not report success',async()=>{
 let calls=0;
 assert.deepEqual(await engineRecovery({query:async()=>{calls++;return {rows:[]};}})(),{checked:0,recovered:0});
 assert.equal(calls,1);
 const db={query:async(sql,args)=>{if(args)throw new Error('Database unavailable');return {rows:[{account_id:'fixture-a',job_id:'job-a',attempt:1}]};}};
 await assert.rejects(engineRecovery(db)(),/Database unavailable/);
});
