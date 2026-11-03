import { transaction } from './database.mjs';
import { canonical,digest } from './repository.mjs';

export function entitlement(customer,purchases,subscriptions,catalog,now=Date.now()) {
  const active=subscriptions.some(subscription=>['active','past_due','canceled'].includes(subscription.status) && Date.parse(subscription.paid_through)>now);
  const valid=purchases.filter(purchase=>!purchase.refunded);
  const total=customer.baseline_total+valid.reduce((sum,purchase)=>sum+purchase.credits,0);
  if (!Number.isSafeInteger(total) || total<0) throw new Error('Credit total is invalid');
  const latest=valid.filter(purchase=>purchase.credits>0).sort((a,b)=>Date.parse(b.paid_at)-Date.parse(a.paid_at))[0];
  const latestOffer=Object.values(catalog).find(offer=>offer.priceId===latest?.price_id);
  // A migrated plan label is history, not proof of a paid recurring period.
  const fallbackTier=customer.baseline_tier==='Unlimited'?'No active subscription':customer.baseline_tier;
  return {totalCredits:active?'Unlimited':String(total),tier:active?'Unlimited':latestOffer?.tier||fallbackTier};
}

export function paymentLedger(database,bridge,catalog,{applicationData=false}={}) {
  async function saveSubscription(connection,accountId,subscription) {
    if (!subscription) return;
    await connection.query(`INSERT INTO pf_subscription(subscription_id,account_id,price_id,status,paid_through) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(subscription_id) DO UPDATE SET status=EXCLUDED.status,paid_through=GREATEST(pf_subscription.paid_through,EXCLUDED.paid_through),updated_at=now()
      WHERE pf_subscription.account_id=EXCLUDED.account_id AND pf_subscription.price_id=EXCLUDED.price_id`,[subscription.subscriptionId,accountId,subscription.priceId,subscription.status,subscription.paidThrough]);
  }
  async function recordPurchase({eventId,eventType,customer,purchase,subscription}) {
    return transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['purchase:'+purchase.sessionId]);
      if (applicationData) await connection.query('SELECT account_id FROM pf_customer WHERE account_id=$1 FOR UPDATE',[customer.accountId]);
      const {rows}=await connection.query('SELECT account_id,price_id,credits FROM pf_purchase WHERE session_id=$1',[purchase.sessionId]);
      if (rows[0] && (rows[0].account_id!==customer.accountId || rows[0].price_id!==purchase.priceId || rows[0].credits!==purchase.credits)) throw new Error('Payment identity conflict');
      await connection.query(`INSERT INTO pf_purchase(session_id,account_id,price_id,credits,stripe_customer_id,payment_intent_id,subscription_id,paid_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id) DO NOTHING`,[purchase.sessionId,customer.accountId,purchase.priceId,purchase.credits,purchase.customerId,purchase.paymentIntentId,purchase.subscriptionId,purchase.paidAt]);
      await connection.query('UPDATE pf_customer SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE account_id=$1',[customer.accountId,purchase.customerId]);
      if (applicationData) {
        await connection.query("INSERT INTO pf_credit_ledger(entry_key,account_id,kind,amount,source_id,reason) VALUES($1,$2,'grant',$3,$4,'Verified Stripe payment') ON CONFLICT(entry_key) DO NOTHING",['stripe-session:'+purchase.sessionId,customer.accountId,purchase.credits,purchase.sessionId]);
        await connection.query("INSERT INTO pf_audit_event(event_key,account_id,action,details) VALUES($1,$2,'payment.verified',$3) ON CONFLICT(event_key) DO NOTHING",['stripe-session:'+purchase.sessionId,customer.accountId,{sessionId:purchase.sessionId,eventId,credits:purchase.credits}]);
      }
      await saveSubscription(connection,customer.accountId,subscription);
      await connection.query("INSERT INTO pf_command(command_id,kind,account_id,payload) VALUES($1,'provision',$2,$3) ON CONFLICT DO NOTHING",['purchase:'+purchase.sessionId,customer.accountId,{sessionId:purchase.sessionId}]);
      await connection.query("INSERT INTO pf_stripe_event(event_id,event_type,resource_id,state,processed_at) VALUES($1,$2,$3,'processed',now()) ON CONFLICT(event_id) DO NOTHING",[eventId,eventType,purchase.sessionId]);
    });
  }
  async function project(accountId,connection) {
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['projection:'+accountId]);
    const {rows:[customer]}=await connection.query('SELECT c.*,u.name,u.email FROM pf_customer c JOIN pf_user u ON c.user_id=u.id WHERE c.account_id=$1',[accountId]);
    if (!customer) throw new Error('Account was not found');
    const {rows:purchases}=await connection.query('SELECT * FROM pf_purchase WHERE account_id=$1 ORDER BY paid_at DESC,session_id DESC',[accountId]);
    const {rows:subscriptions}=await connection.query('SELECT * FROM pf_subscription WHERE account_id=$1',[accountId]);
    const current=entitlement(customer,purchases,subscriptions,catalog);
    if (applicationData) return {customer,current};
    const payload={action:'provision',accountId,email:customer.email,name:customer.name,...current,sessionId:purchases[0]?.session_id||''};
    const fingerprint=digest(canonical(payload));
    if (customer.projection_fingerprint!==fingerprint) {
      const result=await bridge('services',payload);
      if (result.accountId!==accountId || String(result.totalCredits)!==current.totalCredits || result.tier!==current.tier) throw new Error('Entitlement write was not confirmed');
      await connection.query('UPDATE pf_customer SET projection_fingerprint=$2 WHERE account_id=$1',[accountId,fingerprint]);
    }
    return {customer,current};
  }
  async function projectAccount(accountId) {return transaction(database,connection=>project(accountId,connection));}
  async function deliverPurchase(sessionId,sendInvitation) {
    return transaction(database,async connection=>{
      // Account projection is serialized independently of event delivery order.
      const commandId='purchase:'+sessionId;
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[commandId]);
      const {rows:[command]}=await connection.query('SELECT * FROM pf_command WHERE command_id=$1',[commandId]);
      if (!command) throw new Error('Payment has not been verified');
      if (command.state==='done') return command.result;
      const {customer,current}=await project(command.account_id,connection);
      await sendInvitation(customer,current,sessionId);
      const result={success:true,tier:current.tier,invitation:'sent'};
      await connection.query("UPDATE pf_command SET state='done',result=$2,finished_at=now() WHERE command_id=$1",[commandId,result]);
      return result;
    });
  }
  async function recordSubscription(eventId,eventType,subscription) {
    const accountId=await transaction(database,async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['subscription:'+subscription.subscriptionId]);
      const {rows:[purchase]}=await connection.query('SELECT account_id FROM pf_purchase WHERE subscription_id=$1',[subscription.subscriptionId]);
      if (!purchase) return null;
      await saveSubscription(connection,purchase.account_id,subscription);
      await connection.query("INSERT INTO pf_stripe_event(event_id,event_type,resource_id,state,processed_at) VALUES($1,$2,$3,'processed',now()) ON CONFLICT DO NOTHING",[eventId,eventType,subscription.subscriptionId]);
      return purchase.account_id;
    });
    if (accountId) await projectAccount(accountId);
  }
  async function recordFailure(eventId,eventType,sessionId) {
    await database.query("INSERT INTO pf_stripe_event(event_id,event_type,resource_id,state,processed_at) VALUES($1,$2,$3,'ignored',now()) ON CONFLICT DO NOTHING",[eventId,eventType,sessionId]);
  }
  async function receipt(sessionId) {
    const {rows:[command]}=await database.query("SELECT state,result FROM pf_command WHERE command_id=$1 AND kind='provision'",['purchase:'+sessionId]);
    if (command) return {ready:command.state==='done',tier:command.result?.tier};
    const {rowCount}=await database.query("SELECT event_id FROM pf_stripe_event WHERE resource_id=$1 AND event_type IN ('checkout.session.async_payment_failed','checkout.session.expired') LIMIT 1",[sessionId]);
    return rowCount?{failed:true}:null;
  }
  return {recordPurchase,recordSubscription,recordFailure,receipt,deliverPurchase,projectAccount};
}
