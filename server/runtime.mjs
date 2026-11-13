import {getDatabase} from './database.mjs';
import {applicationStore} from './application-store.mjs';
import {createAuth,awaitResetDelivery} from './auth.mjs';
import {authAudit} from './auth-audit.mjs';
import {repository} from './repository.mjs';
import {makeBridge} from './make.mjs';
import {customerService} from './customers.mjs';
import {deliveryService,escapeHtml} from './delivery.mjs';
import {paymentLedger} from './ledger.mjs';
import {offerCatalog} from './offers.mjs';
import {createPayments} from './payments.mjs';
import {createPortal} from './portal.mjs';
import {uploadOwnership} from './upload-ownership.mjs';
import {enginePipeline} from './engine-pipeline.mjs';
import {engineConfiguration} from './engine-configuration.mjs';
import {getVercelOidcToken} from '@vercel/oidc';
import {r2Store} from './r2-store.mjs';
import {mediaService} from './media-service.mjs';

let portal;
export function getPortal(env=process.env) {
  if (portal) return portal;
  const baseURL=env.VERCEL_ENV==='preview'?'https://'+env.VERCEL_URL:env.PF_SITE_URL;
  if (!baseURL || !/^https:\/\//.test(baseURL)) throw new Error('Site origin is not configured');
  const useApplicationData=env.PF_DATA_AUTHORITY==='neon';
  if (env.PF_DATA_AUTHORITY && !['legacy','neon'].includes(env.PF_DATA_AUTHORITY)) throw new Error('Unknown application data authority');
  const engineConfig=engineConfiguration(env,useApplicationData);
  const dataOptions={applicationData:useApplicationData};
  const database=getDatabase();
  // Keep callbacks and auth queries available while a ledger transaction waits
  // for a sequential Make workflow to finish.
  const accounts=repository(getDatabase('control'),dataOptions);
  const previewServiceAccess=env.PF_PREVIEW_SERVICE_ACCESS==='oidc';
  if (previewServiceAccess && env.VERCEL_ENV!=='preview') throw new Error('Preview callback access cannot be used in production');
  const bridge=makeBridge(accounts,{account:env.PF_MAKE_ACCOUNT_URL,engine:env.PF_MAKE_ENGINE_URL,logo:env.PF_MAKE_LOGO_URL,services:env.PF_MAKE_SERVICES_URL},fetch,{
    callbackAuthorization:previewServiceAccess?getVercelOidcToken:undefined,
    engineCallbackAuthorization:engineConfig.previewIdentity?getVercelOidcToken:undefined
  });
  const customers=customerService(database,bridge,dataOptions);
  const delivery=deliveryService(database,bridge,baseURL,dataOptions);
  const auth=createAuth({database:getDatabase('auth'),baseURL,secret:env.BETTER_AUTH_SECRET,sendPasswordReset:delivery.reset,audit:useApplicationData?authAudit(getDatabase('control')):undefined});
  const live=env.PF_STRIPE_MODE==='live';
  if (env.VERCEL_ENV==='preview' && live) throw new Error('Preview must use test payments');
  const catalog=offerCatalog(live?undefined:JSON.parse(env.PF_STRIPE_TEST_PRICES||'null'));
  const ledger=paymentLedger(database,bridge,catalog,dataOptions);
  let payments;
  if (env.PF_CHECKOUT_ENABLED==='true') {
    if (!live && !env.PF_STRIPE_TEST_PRICES) throw new Error('Test offers are required');
    if (live && !['verified','not_required_confirmed'].includes(env.PF_STRIPE_AUTOMATIC_TAX)) throw new Error('Live tax treatment has not been confirmed');
    payments=createPayments({secretKey:env.STRIPE_SECRET_KEY,webhookSecret:env.STRIPE_WEBHOOK_SECRET,accountId:env.PF_STRIPE_ACCOUNT_ID,live,catalog,baseURL,store:ledger,customers,automaticTax:env.PF_STRIPE_AUTOMATIC_TAX==='verified',
      deliver:sessionId=>ledger.deliverPurchase(sessionId,async (customer,current,id)=>{
        const {rowCount}=await getDatabase('auth').query('SELECT id FROM pf_credential WHERE "userId"=$1 AND "providerId"=$2 AND password IS NOT NULL LIMIT 1',[customer.user_id,'credential']);
        if (!rowCount) {
          await awaitResetDelivery(()=>auth.api.requestPasswordReset({body:{email:customer.email}}),{required:true});
        } else {
          const result=await bridge('services',{action:'email',commandId:'receipt:'+id,email:customer.email,subject:'Your PremiereFlow plan is ready',html:`<p>Your ${escapeHtml(current.tier)} purchase is ready.</p><p><a href="${baseURL}/login/">Sign in to your dashboard</a> to view your available credits.</p>`});
          if (result.delivery!=='sent') throw new Error('Receipt delivery was not confirmed');
        }
      })});
  }
  if(!['','uploadcare','r2'].includes(env.PF_STORAGE_PROVIDER||''))throw new Error('Unknown photo storage provider');
  if(env.PF_STORAGE_PROVIDER==='r2'&&!useApplicationData)throw new Error('Private storage requires Neon ownership');
  const media=env.PF_STORAGE_PROVIDER==='r2'?mediaService(database,r2Store(env),baseURL):undefined;
  const uploads=media||(useApplicationData?uploadOwnership(env.BETTER_AUTH_SECRET):undefined);
  const engine=engineConfig.enabled?enginePipeline({database,accounts,bridge,uploads,baseURL,acceptanceAccount:engineConfig.acceptanceAccount,media}):undefined;
  portal=createPortal({auth,repository:accounts,bridge,baseURL,ensureExistingAccount:customers.ensureExisting,sendSupport:delivery.support,payments,beforeAccountRead:account=>ledger.projectAccount(account.accountId),applicationData:useApplicationData?applicationStore(database,catalog):undefined,uploads,media,engine,maintenanceSecret:env.CRON_SECRET,submissionsEnabled:env.PF_SUBMISSIONS_ENABLED==='true'});
  return portal;
}
