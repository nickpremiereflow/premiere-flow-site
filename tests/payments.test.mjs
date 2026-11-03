import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {createPayments,validatePaidSession,subscriptionSnapshot} from '../server/payments.mjs';
import {offers} from '../server/offers.mjs';
import {entitlement} from '../server/ledger.mjs';
import {validateLegacyAccount} from '../server/customers.mjs';
import {makePayload} from '../server/contracts.mjs';

const secret='whsec_controlled_fixture_only';
const accountId='acct_controlled';
const session={id:'cs_live_controlled',status:'complete',payment_status:'paid',livemode:true,mode:'payment',currency:'usd',amount_subtotal:34900,customer:'cus_controlled',customer_details:{email:'New@Example.test',name:'Controlled customer'},metadata:{integration:'pfsecure'},created:1793592000};
const lines={data:[{quantity:1,amount_subtotal:34900,price:{id:offers.partner.priceId,currency:'usd',unit_amount:34900}}],has_more:false};
function fixture() {
  const purchases=new Map();const receipts=new Map();const failures=[];const checkoutRequests=[];let accountReads=0;let customerCalls=0;
  const client={webhooks:Stripe.webhooks,accounts:{retrieve:async()=>{accountReads++;return {id:accountId};}},
    checkout:{sessions:{retrieve:async()=>session,listLineItems:async()=>lines,create:async input=>{checkoutRequests.push(input);return {url:'https://checkout.stripe.com/c/pay/cs_live_controlled'};}}},
    prices:{retrieve:async id=>{const offer=Object.values(offers).find(value=>value.priceId===id);return {id,active:true,livemode:true,currency:'usd',unit_amount:offer.amount,...(offer.mode==='subscription'?{recurring:{interval:'month',interval_count:1}}:{})};}}
  };
  const store={recordPurchase:async ({purchase})=>{purchases.set(purchase.sessionId,purchase);},recordSubscription:async()=>{},recordFailure:async(...args)=>failures.push(args),receipt:async id=>receipts.get(id)};
  const payments=createPayments({secretKey:'rk_live_controlled',webhookSecret:secret,accountId,live:true,catalog:offers,baseURL:'https://www.premiereflow.com',client,store,customers:{resolvePaidPurchase:async purchase=>{customerCalls++;return {accountId:purchase.accountId||'PF-Controlled'};},checkoutCustomer:async account=>{if(account.accountId!=='PF-Existing')throw new Error('Unexpected account');return 'cus_existing';}},deliver:async id=>{receipts.set(id,{ready:true,tier:'Partner Pack'});}});
  async function webhook(type='checkout.session.completed',id='evt_controlled',signatureValid=true) {
    const payload=JSON.stringify({id,type,livemode:true,data:{object:session}});
    const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:signatureValid?secret:'wrong-secret'});
    return payments.webhook(new Request('https://www.premiereflow.com/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':signature},body:payload}));
  }
  return {payments,webhook,purchases,receipts,failures,checkoutRequests,client,get customerCalls(){return customerCalls;},get accountReads(){return accountReads;}};
}

test('verified paid partner offer grants ten credits, while unpaid or unrelated payment grants none',()=>{
  const purchase=validatePaidSession(session,lines,offers,true);
  assert.equal(purchase.credits,10);assert.equal(purchase.email,'new@example.test');
  assert.equal(validatePaidSession({...session,payment_status:'unpaid'},lines,offers,true),null);
  assert.equal(validatePaidSession({...session,status:'open'},lines,offers,true),null);
  assert.equal(validatePaidSession(session,{...lines,data:[{...lines.data[0],price:{...lines.data[0].price,id:'price_unrelated'}}]},offers,true),null);
  assert.equal(validatePaidSession({...session,metadata:{}},lines,offers,true),null);
  assert.throws(()=>validatePaidSession({...session,livemode:false},lines,offers,true));
  assert.throws(()=>validatePaidSession({...session,amount_subtotal:1},lines,offers,true));
  assert.throws(()=>validatePaidSession(session,{...lines,data:[{...lines.data[0],quantity:2}]},offers,true));
});

test('forged Stripe signature fails before account lookup or any entitlement write',async()=>{
  const f=fixture();
  await assert.rejects(f.webhook('checkout.session.completed','evt_bad',false),error=>error.status===400);
  assert.equal(f.customerCalls,0);assert.equal(f.accountReads,0);assert.equal(f.purchases.size,0);
});

test('duplicate paid events converge on the same checkout session and one entitlement',async()=>{
  const f=fixture();
  await f.webhook();await f.webhook();await f.webhook('checkout.session.async_payment_succeeded','evt_second');
  assert.equal(f.purchases.size,1);
  assert.equal([...f.purchases.values()].reduce((sum,p)=>sum+p.credits,0),10);
  assert.equal((await (await f.payments.status(session.id)).json()).status,'ready');
});

test('failed payment grants nothing; a frontend confirmation visit cannot fulfill a payment',async()=>{
  const f=fixture();
  await f.webhook('checkout.session.async_payment_failed','evt_failed');
  assert.equal(f.purchases.size,0);assert.equal(f.customerCalls,0);assert.equal(f.failures.length,1);
  assert.equal((await (await f.payments.status(session.id)).json()).status,'pending');
  assert.equal(f.purchases.size,0);assert.equal(f.customerCalls,0);
});

test('each existing public offer opens Stripe Checkout with explicit return routes',async()=>{
  const f=fixture();
  for(const key of Object.keys(offers)){
    const response=await f.payments.checkout(key);assert.equal(response.status,200);
    const input=f.checkoutRequests.at(-1);
    assert.equal(input.line_items[0].price,offers[key].priceId);
    assert.equal(input.line_items[0].quantity,1);assert.equal(input.mode,offers[key].mode);
    assert.equal(input.success_url,'https://www.premiereflow.com/confirmation/?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(input.cancel_url,'https://www.premiereflow.com/sign-up/?checkout=cancelled');
    assert.equal('payment_method_types' in input,false);
    assert.match(input.integration_identifier,/^premiereflow_[a-z]{8}$/);
    assert.equal('automatic_tax' in input,false);
  }
  await assert.rejects(f.payments.checkout('unrelated'),error=>error.status===400);
  f.client.accounts.retrieve=async()=>({id:'acct_wrong'});
  const wrong=fixture();wrong.client.accounts.retrieve=async()=>({id:'acct_wrong'});
  await assert.rejects(wrong.payments.checkout('upgrade'));
  assert.equal(wrong.checkoutRequests.length,0);
});

test('Unlimited requires a paid invoice period and expires without granting extra pack credits',()=>{
  const subscription={id:'sub_controlled',livemode:true,customer:'cus_controlled',status:'active',items:{data:[{quantity:1,price:{id:offers.unlimited.priceId}}]}};
  const invoice={id:'in_controlled',livemode:true,status:'paid',paid:true,amount_paid:99900,parent:{subscription_details:{subscription:'sub_controlled'}},lines:{data:[{pricing:{price_details:{price:offers.unlimited.priceId}},period:{end:2000000000}}]}};
  const snapshot=subscriptionSnapshot(subscription,invoice,offers,true);
  assert.ok(snapshot.paidThrough);
  assert.equal(subscriptionSnapshot(subscription,{...invoice,status:'open',paid:false},offers,true).paidThrough,null);
  const customer={baseline_total:10,baseline_tier:'Partner Pack'};
  const subscriptions=[{status:'active',paid_through:snapshot.paidThrough}];
  assert.equal(entitlement(customer,[],subscriptions,offers,1999999999000).totalCredits,'Unlimited');
  assert.equal(entitlement(customer,[],subscriptions,offers,2000000001000).totalCredits,'10');
  assert.equal(entitlement(customer,[{credits:1,price_id:offers.branding.priceId,paid_at:'2026-11-01'}],[],offers).totalCredits,'11');
});

test('a legacy Unlimited label cannot bypass the verified subscription expiry',()=>{
  const customer={baseline_total:2,baseline_tier:'Unlimited'};
  const now=Date.parse('2026-11-03T12:00:00Z');
  assert.deepEqual(entitlement(customer,[],[],offers,now),{totalCredits:'2',tier:'No active subscription'});
  for(const status of ['active','past_due','canceled']) {
    assert.equal(entitlement(customer,[],[{status,paid_through:new Date(now+60000).toISOString()}],offers,now).totalCredits,'Unlimited');
    assert.equal(entitlement(customer,[],[{status,paid_through:new Date(now-1).toISOString()}],offers,now).totalCredits,'2');
  }
  for(const status of ['incomplete','incomplete_expired','unpaid','paused']) {
    assert.equal(entitlement(customer,[],[{status,paid_through:new Date(now+60000).toISOString()}],offers,now).totalCredits,'2');
  }
});

test('legacy migration preserves total credits and identity without importing passwords',()=>{
  const account=validateLegacyAccount({success:true,found:true,count:1,accountId:'PF-TEST-999',email:'existing@example.test',name:'Existing',tier:'Partner Pack',totalCredits:'10.00'},'existing@example.test');
  assert.equal(account.baselineTotal,10);assert.equal(account.accountId,'PF-TEST-999');
  assert.equal(validateLegacyAccount({success:true,found:false},'new@example.test'),null);
  assert.throws(()=>validateLegacyAccount({success:true,found:true,count:2,email:'existing@example.test'},'existing@example.test'));
  assert.equal(Object.keys(account).some(key=>/password|salt/i.test(key)),false);
});

test('Make tickets bind every engine input, including retry and email controls',()=>{
  const payload=makePayload('engine',{jobId:'controlled',expectedAttempt:1});
  assert.equal(payload.expectedAttempt,'1');assert.equal(payload.sendEmail,'true');assert.equal(payload.vehicleName,'');
  assert.throws(()=>makePayload('engine',{unknown:'unbound'}));
});


test('signed-in repeat Checkout uses a stable customer and server-owned account metadata',async()=>{
  const f=fixture();
  const account={accountId:'PF-Existing',userId:'existing-user',email:'owner@example.test'};
  await f.payments.checkout('partner',account);
  await f.payments.checkout('upgrade',account);
  for(const input of f.checkoutRequests){
    assert.equal(input.customer,'cus_existing');
    assert.equal(input.metadata.accountId,'PF-Existing');
    assert.equal('customer_creation' in input,false);
    assert.equal('customer_email' in input,false);
  }
});

test('verified session metadata is retained, while a payment-link client reference cannot select an account',()=>{
  assert.equal(validatePaidSession({...session,metadata:{integration:'pfsecure',accountId:'PF-Existing'}},lines,offers,true).accountId,'PF-Existing');
  assert.equal(validatePaidSession({...session,client_reference_id:'PF-Foreign'},lines,offers,true).accountId,null);
});
