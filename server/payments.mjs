import Stripe from 'stripe';
import { HttpError,json } from './http.mjs';
import { normalizeEmail } from './customers.mjs';

export const stripeObjectId = value => typeof value==='string'?value:value?.id;
const sessionPattern=/^cs_(live|test)_[A-Za-z0-9]+$/;
export const integrationId='pfsecure';

export function validatePaidSession(session,lines,catalog,live) {
  if (session.livemode!==live || !sessionPattern.test(session.id)) throw new Error('Payment environment mismatch');
  if (session.status!=='complete' || session.payment_status!=='paid') return null;
  if (!Array.isArray(lines.data) || lines.data.length!==1 || lines.has_more) throw new Error('Unexpected payment items');
  const item=lines.data[0];
  const offer=Object.values(catalog).find(value=>value.priceId===item.price?.id);
  // This Stripe account also contains unrelated products. They grant nothing here.
  if (!offer) return null;
  if (session.metadata?.integration!==integrationId && stripeObjectId(session.payment_link)!==offer.linkId) return null;
  if (item.quantity!==1 || session.currency!=='usd' || item.price.currency!=='usd' || item.price.unit_amount!==offer.amount || session.amount_subtotal!==offer.amount || item.amount_subtotal!==offer.amount || session.mode!==offer.mode) throw new Error('Payment does not match the purchased offer');
  if (!stripeObjectId(session.customer)?.startsWith('cus_')) throw new Error('Payment customer missing');
  const email=normalizeEmail(session.customer_details?.email);
  return {sessionId:session.id,customerId:stripeObjectId(session.customer),email,name:session.customer_details?.name||'Customer',priceId:offer.priceId,credits:offer.credits,tier:offer.tier,subscriptionId:stripeObjectId(session.subscription)||null,paymentIntentId:stripeObjectId(session.payment_intent)||null,paidAt:new Date(session.created*1000).toISOString()};
}

export function subscriptionSnapshot(subscription,invoice,catalog,live) {
  if (subscription.livemode!==live) throw new Error('Subscription environment mismatch');
  const items=subscription.items?.data||[];
  const offer=Object.values(catalog).find(value=>value.mode==='subscription' && items.length===1 && value.priceId===items[0].price?.id);
  if (!offer || items[0].quantity!==1) return null;
  const invoiceSubscription=stripeObjectId(invoice?.parent?.subscription_details?.subscription||invoice?.subscription);
  const line=invoice?.lines?.data?.find(item=>stripeObjectId(item.pricing?.price_details?.price||item.price)===offer.priceId && item.period?.end);
  const paid=invoice?.livemode===live && invoice.status==='paid' && invoice.paid!==false && invoiceSubscription===subscription.id && invoice.amount_paid>0;
  return {subscriptionId:subscription.id,customerId:stripeObjectId(subscription.customer),priceId:offer.priceId,status:subscription.status,paidThrough:paid&&line?new Date(line.period.end*1000).toISOString():null};
}

export function createPayments({secretKey,webhookSecret,accountId,live,catalog,baseURL,store,customers,deliver,client}) {
  if (!secretKey || !webhookSecret || !accountId) throw new Error('Payment credentials are not configured');
  if (secretKey.includes(live?'_test_':'_live_')) throw new Error('Payment credentials use the wrong environment');
  const stripe=client||new Stripe(secretKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:2,timeout:12000,appInfo:{name:'PremiereFlow',version:'2.0.0',url:baseURL}});
  let accountVerified=false;
  async function verifyAccount() {
    if (accountVerified) return;
    const account=await stripe.accounts.retrieve();
    if (account.id!==accountId) throw new Error('Stripe account mismatch');
    accountVerified=true;
  }
  async function readSubscription(id,paidInvoice) {
    const subscription=await stripe.subscriptions.retrieve(id,{expand:['latest_invoice']});
    let invoice=paidInvoice||subscription.latest_invoice;
    if (typeof invoice==='string') invoice=await stripe.invoices.retrieve(invoice,{expand:['lines.data']});
    return subscriptionSnapshot(subscription,invoice,catalog,live);
  }
  async function fulfill(sessionId,eventId,eventType) {
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    const lines=await stripe.checkout.sessions.listLineItems(sessionId,{limit:2});
    const purchase=validatePaidSession(session,lines,catalog,live);
    if (!purchase) return false;
    const customer=await customers.ensurePaid(purchase.email,purchase.name);
    const firstInvoice=purchase.subscriptionId&&stripeObjectId(session.invoice)?await stripe.invoices.retrieve(stripeObjectId(session.invoice)):null;
    const subscription=purchase.subscriptionId?await readSubscription(purchase.subscriptionId,firstInvoice):null;
    if (purchase.subscriptionId && (!subscription || !subscription.paidThrough)) throw new Error('Paid subscription period was not confirmed');
    await store.recordPurchase({eventId,eventType,customer,purchase,subscription});
    await deliver(purchase.sessionId);
    return true;
  }
  async function webhook(request) {
    const signature=request.headers.get('stripe-signature');
    if (!signature) throw new HttpError(400,'Payment signature is missing.');
    const raw=Buffer.from(await request.arrayBuffer());
    if (raw.length>262144) throw new HttpError(413,'Event is too large.');
    let event;
    try {event=stripe.webhooks.constructEvent(raw,signature,webhookSecret,300);} catch {throw new HttpError(400,'Payment signature is invalid.');}
    if (event.livemode!==live || event.account && event.account!==accountId) throw new HttpError(400,'Payment environment is invalid.');
    await verifyAccount();
    const object=event.data.object;
    if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
      await fulfill(object.id,event.id,event.type);
    } else if (['customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'].includes(event.type)) {
      const subscriptionId=event.type.startsWith('customer.subscription.')?object.id:stripeObjectId(object.parent?.subscription_details?.subscription||object.subscription);
      if (subscriptionId) {
        const current=await readSubscription(subscriptionId);
        if (current) await store.recordSubscription(event.id,event.type,current);
      }
    } else if (event.type==='checkout.session.async_payment_failed' || event.type==='checkout.session.expired') {
      await store.recordFailure(event.id,event.type,object.id);
    }
    return json({received:true});
  }
  async function checkout(key) {
    const offer=Object.hasOwn(catalog,key)?catalog[key]:null;
    if (!offer) throw new HttpError(400,'Choose one of the listed plans.');
    await verifyAccount();
    const price=await stripe.prices.retrieve(offer.priceId);
    if (!price.active || price.livemode!==live || price.currency!=='usd' || price.unit_amount!==offer.amount || (offer.mode==='subscription' && (price.recurring?.interval!=='month' || price.recurring.interval_count!==1))) throw new Error('The offer is not available as configured');
    const session=await stripe.checkout.sessions.create({
      mode:offer.mode,line_items:[{price:offer.priceId,quantity:1}],
      ...(offer.mode==='payment'?{customer_creation:'always'}:{subscription_data:{metadata:{integration:integrationId,offer:key}}}),
      metadata:{integration:integrationId,offer:key},automatic_tax:{enabled:true},
      success_url:baseURL+'/confirmation/?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:baseURL+'/sign-up/?checkout=cancelled'
    });
    const url=new URL(session.url);
    if (url.protocol!=='https:' || url.hostname!=='checkout.stripe.com') throw new Error('Unexpected checkout destination');
    return json({success:true,url:url.href});
  }
  async function status(sessionId) {
    if (!sessionPattern.test(sessionId||'')) throw new HttpError(400,'This confirmation link is invalid.');
    // Only a verified webhook can create this receipt. A success-page visit grants nothing.
    const receipt=await store.receipt(sessionId);
    if (!receipt) return json({success:true,status:'pending'});
    if (receipt.failed) return json({success:true,status:'failed'});
    return json({success:true,status:receipt.ready?'ready':'provisioning',...(receipt.ready?{tier:receipt.tier,invitation:'sent'}:{})});
  }
  return {webhook,checkout,status};
}
