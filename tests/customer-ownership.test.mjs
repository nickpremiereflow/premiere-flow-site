import test from 'node:test';
import assert from 'node:assert/strict';
import {customerService} from '../server/customers.mjs';

function databaseFixture({linked=[],byEmail=null,locked=null}={}) {
  const writes=[];
  const client={release(){},async query(sql,args=[]){
    if (sql.includes('WHERE c.stripe_customer_id=$1 OR EXISTS'))return {rows:linked};
    if (sql.includes('FOR UPDATE OF c'))return {rows:locked?[locked]:[]};
    if (sql.includes('WHERE lower(u.email)=$1'))return {rows:byEmail?[byEmail]:[]};
    if (/^(INSERT|UPDATE)/.test(sql))writes.push({sql,args});
    return {rows:[],rowCount:1};
  }};
  return {database:{connect:async()=>client,query:client.query},writes};
}
const owner={accountId:'PF-Owner',userId:'owner-user',email:'owner@example.test',stripeCustomerId:'cus_owner'};

test('trusted billing relationship wins over a changed payment email and prevents account reassignment',async()=>{
  const f=databaseFixture({linked:[owner]});
  const service=customerService(f.database,()=>{throw new Error('Legacy access forbidden');},{applicationData:true});
  const purchase={customerId:'cus_owner',email:'other@example.test',name:'Other'};
  assert.equal((await service.resolvePaidPurchase(purchase)).accountId,'PF-Owner');
  await assert.rejects(service.resolvePaidPurchase({...purchase,accountId:'PF-Foreign'}),/ownership conflict/);
  assert.equal(f.writes.length,0);
});

test('unbound paid metadata cannot select an existing account',async()=>{
  const f=databaseFixture();
  const service=customerService(f.database,null,{applicationData:true});
  await assert.rejects(service.resolvePaidPurchase({customerId:'cus_unknown',accountId:'PF-Foreign',email:'owner@example.test'}),/not confirmed/);
  assert.equal(f.writes.length,0);
});

test('guest repeat purchase preserves existing owner and canonical customer while retaining the new billing alias',async()=>{
  const f=databaseFixture({byEmail:owner});
  const service=customerService(f.database,null,{applicationData:true});
  const result=await service.resolvePaidPurchase({customerId:'cus_repeat',email:'owner@example.test',name:'Changed payer name'});
  assert.equal(result.userId,'owner-user');
  assert.equal(f.writes.some(x=>x.sql.startsWith('INSERT INTO pf_user')),false);
  assert.equal(f.writes.some(x=>x.sql.startsWith('UPDATE pf_user')),false);
  assert.deepEqual(f.writes.find(x=>x.sql.startsWith('INSERT INTO pf_billing_customer')).args,['cus_repeat','PF-Owner']);
});

test('authenticated repeat checkout reuses the locked canonical customer without creating another',async()=>{
  const f=databaseFixture({locked:owner});
  const service=customerService(f.database,null,{applicationData:true});
  assert.equal(await service.checkoutCustomer(owner,()=>{throw new Error('Duplicate customer creation');}),'cus_owner');
  assert.equal(f.writes.length,0);
});
