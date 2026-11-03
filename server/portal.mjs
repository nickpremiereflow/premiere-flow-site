import { isPublicAuthRoute, awaitResetDelivery } from './auth.mjs';
import { requireAccount, rejectForeignIdentity, JOB_ID_PATTERN } from './access.mjs';
import { HttpError, json, onlyKeys, readJson, requireSameOrigin, safeError, shortText } from './http.mjs';

const colors = new Set(['White (default)','Black','Gold','Red','Blue','Green']);
const placements = new Set(['No Logo','Bottom Left','Bottom Right','Top Right','Top Left']);
const uploadcareHost = /(^|\.)ucarecdn\.com$|(^|\.)ucarecd\.net$/;

export function validateImageUrl(value, {group = false, optional = false} = {}) {
  if (optional && !value) return '';
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400,'Upload a valid image first.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !uploadcareHost.test(url.hostname) || url.search || url.hash) throw new HttpError(400,'The image storage link is invalid.');
  if (group ? !/^\/[0-9a-f-]{36}~(?:[1-9]|10)\/$/i.test(url.pathname) : !/^\/[0-9a-f-]{36}(?:\/|~(?:[1-9]|10)\/nth\/\d+\/)/i.test(url.pathname)) throw new HttpError(400,'The uploaded image link is invalid.');
  return url.href;
}

export function validateDashboard(data, account) {
  if (data?.success !== true || (data.accountId || data.accountID) !== account.accountId) throw new HttpError(503,'Account details could not be confirmed.','ACCOUNT_UNAVAILABLE');
  const unlimited = String(data.credits).toUpperCase() === 'UNLIMITED';
  const numeric = (typeof data.credits === 'number' || typeof data.credits === 'string' && /^\d+$/.test(data.credits.trim())) && Number.isSafeInteger(Number(data.credits)) && Number(data.credits) >= 0;
  if ((!unlimited && !numeric) || !Array.isArray(data.listings) || data.listings.some(job => !job || typeof job !== 'object')) throw new HttpError(503,'Account details could not be confirmed.','ACCOUNT_UNAVAILABLE');
  return {success:true, accountId:account.accountId, email:account.email, name:data.name || '', tier:data.tier, credits:unlimited?'Unlimited':Number(data.credits), logo:data.logo || '', listings:data.listings};
}

export function createPortal({auth, repository, bridge, baseURL, ensureExistingAccount, sendSupport, payments, beforeAccountRead, submissionsEnabled = false}) {
  const origin = new URL(baseURL).origin;
  const dashboard = async account => {
    if (beforeAccountRead) await beforeAccountRead(account);
    return validateDashboard(await bridge('account',{action:'read',email:account.email,accountId:account.accountId}),account);
  };
  const ownedJob = async (account,jobId) => {
    if (!JOB_ID_PATTERN.test(jobId || '')) throw new HttpError(400,'The Job ID is invalid.');
    const data = await dashboard(account);
    const job = data.listings.find(item => item.jobId === jobId);
    if (!job) throw new HttpError(404,'Listing not found.','JOB_NOT_FOUND');
    return {data,job};
  };
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/,'');
      if (path === '/api/stripe/webhook' && request.method === 'POST') {
        if (!payments) throw new HttpError(503,'Payment processing is not ready.');
        return await payments.webhook(request);
      }
      if (path === '/api/internal/make/authorize' && request.method === 'POST') {
        const body = await readJson(request,65536);
        onlyKeys(body,['ticket','audience','payload']);
        if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) || !await repository.consumeTicket(body.ticket,body.audience,body.payload)) throw new HttpError(403,'Request authorization failed.','INVALID_TICKET');
        return json({authorized:true});
      }
      if (path === '/api/internal/make/result' && request.method === 'POST') {
        const body=await readJson(request,65536);
        onlyKeys(body,['ticket','status','result']);
        if (!await repository.completeTicket(body.ticket,body.status,body.result)) throw new HttpError(403,'Result authorization failed.','INVALID_TICKET');
        return json({received:true});
      }
      if (isPublicAuthRoute(path,request.method)) {
        if (request.method === 'POST') {
          requireSameOrigin(request,origin);
          const body = await readJson(request);
          const fields = {
            '/api/auth/sign-in/email':['email','password'],
            '/api/auth/sign-out':[],
            '/api/auth/request-password-reset':['email'],
            '/api/auth/reset-password':['token','newPassword']
          }[path];
          onlyKeys(body,fields);
          if ('email' in body) body.email = shortText(body.email,254,'Email').toLowerCase();
          if (path === '/api/auth/request-password-reset') {
            await repository.rateLimit('reset-ip:'+request.headers.get('x-real-ip'),3,300);
            await repository.rateLimit('reset-email:'+body.email,3,900);
            if (!ensureExistingAccount) throw new HttpError(503,'Account recovery is not ready.');
            await ensureExistingAccount(body.email);
          }
          const requestHeaders = new Headers(request.headers);
          requestHeaders.delete('content-length');
          request = new Request(request.url,{method:'POST',headers:requestHeaders,body:JSON.stringify(body)});
        }
        const response = path === '/api/auth/request-password-reset'
          ? await awaitResetDelivery(()=>auth.handler(request))
          : await auth.handler(request);
        const headers = new Headers(response.headers);
        headers.set('cache-control','no-store');
        // Session cookies are HttpOnly. The browser only needs display identity.
        if (['/api/auth/get-session','/api/auth/sign-in/email'].includes(path) && response.ok) {
          const value = await response.json();
          return new Response(JSON.stringify(value?.user ? {user:{id:value.user.id,email:value.user.email,name:value.user.name}} : null),{status:response.status,headers});
        }
        return new Response(response.body,{status:response.status,headers});
      }
      if (path.startsWith('/api/auth/')) throw new HttpError(404,'Not found.');
      if (path === '/api/checkout' && request.method === 'POST') {
        requireSameOrigin(request,origin);
        await repository.rateLimit('checkout:'+request.headers.get('x-real-ip'),5,60);
        if (!payments) throw new HttpError(503,'Checkout is not ready.');
        const body = await readJson(request);
        onlyKeys(body,['offer']);
        return await payments.checkout(body.offer);
      }
      if (path === '/api/checkout/status' && request.method === 'GET') {
        if (!payments) throw new HttpError(503,'Payment verification is not ready.');
        return await payments.status(url.searchParams.get('session_id'));
      }
      const {account,session} = await requireAccount(auth,repository,request.headers);
      rejectForeignIdentity(Object.fromEntries(url.searchParams),account);
      if (path === '/api/account' && request.method === 'GET') return json(await dashboard(account));
      if (request.method !== 'POST') throw new HttpError(404,'Not found.');
      requireSameOrigin(request,origin);
      const body = await readJson(request);
      rejectForeignIdentity(body,account);
      await repository.rateLimit('account:'+session.user.id,30,60);
      if (path === '/api/account') {
        if (body.action === 'update_name') {
          onlyKeys(body,['action','newName']);
          const name = shortText(body.newName,100,'Name');
          const result = await bridge('account',{action:'update_name',accountId:account.accountId,email:account.email,newName:name});
          return json({success:result.success === true});
        }
        if (body.action === 'rename_listing') {
          onlyKeys(body,['action','jobId','newName']);
          await ownedJob(account,body.jobId);
          const result = await bridge('account',{action:'rename_listing',accountId:account.accountId,email:account.email,jobId:body.jobId,newName:shortText(body.newName,160,'Listing name')});
          return json({success:result.success === true});
        }
        throw new HttpError(400,'Unknown account update.');
      }
      if (path === '/api/account/logo') {
        onlyKeys(body,['logoUrl']);
        const logoUrl = validateImageUrl(body.logoUrl);
        const result = await bridge('logo',{email:account.email,accountId:account.accountId,logoUrl});
        return json({success:result.success === true});
      }
      if (path === '/api/jobs') {
        if (!submissionsEnabled) throw new HttpError(503,'Submissions are temporarily paused. Your credits are safe.','SUBMISSIONS_PAUSED');
        if (!JOB_ID_PATTERN.test(body.jobId || '')) throw new HttpError(400,'The Job ID is invalid.');
        if (body.action === 'retry') {
          onlyKeys(body,['action','jobId','expectedAttempt']);
          const {data,job} = await ownedJob(account,body.jobId);
          const retryAt = job.nextRetryAt ? Date.parse(job.nextRetryAt) : 0;
          if (!['FAILED','RETRY_REQUIRED'].includes(String(job.status).trim().toUpperCase()) || !Number.isInteger(body.expectedAttempt) || body.expectedAttempt !== Number(job.attemptCount) || body.expectedAttempt >= 3 || !Number.isFinite(retryAt) || retryAt>Date.now()) throw new HttpError(409,'This job is not ready to retry. Refresh its status first.');
          if (data.credits !== 'Unlimited' && data.credits < 1) throw new HttpError(409,'There are no available listing credits.');
          return json(await bridge('engine',{email:account.email,accountId:account.accountId,action:'retry',jobId:body.jobId,expectedAttempt:String(body.expectedAttempt)},{acceptedOnly:true}),202);
        }
        if (body.action !== 'submit') throw new HttpError(400,'Unknown job action.');
        onlyKeys(body,['action','jobId','vehicleName','assetSource','showroomColor','logoPlacement','thumbnail','uploadcareUrl']);
        if (!colors.has(body.showroomColor) || !placements.has(body.logoPlacement)) throw new HttpError(400,'Choose a valid showroom and logo placement.');
        const payload = {
          email:account.email,accountId:account.accountId,action:'submit',jobId:body.jobId,
          vehicleName:shortText(body.vehicleName,160,'Vehicle name'),
          assetSource:typeof body.assetSource==='string'?body.assetSource.slice(0,2000):'',
          showroomColor:body.showroomColor,logoPlacement:body.logoPlacement,
          thumbnail:validateImageUrl(body.thumbnail,{optional:true}),uploadcareUrl:validateImageUrl(body.uploadcareUrl,{group:true})
        };
        const existing = await repository.findOwned(account.accountId,body.jobId);
        if (!existing) {
          const data = await dashboard(account);
          if (data.credits !== 'Unlimited' && data.credits < 1) throw new HttpError(409,'There are no available listing credits.');
        }
        await repository.registerJob(account.accountId,body.jobId,payload);
        return json(await bridge('engine',payload,{acceptedOnly:true}),202);
      }
      if (path === '/api/support') {
        onlyKeys(body,['requestId','subject','message']);
        if (!JOB_ID_PATTERN.test(body.requestId || '')) throw new HttpError(400,'The message ID is invalid.');
        if (!sendSupport) throw new HttpError(503,'Support delivery is not available yet.');
        return json(await sendSupport(account,{requestId:body.requestId,subject:shortText(body.subject,160,'Subject'),message:shortText(body.message,5000,'Message')}));
      }
      throw new HttpError(404,'Not found.');
    } catch (error) {return safeError(error);}
  };
}
