import {AwsClient} from './vendor/aws4fetch.mjs';
import {HttpError} from './http.mjs';

const types=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const keyPattern=/^v1\/(?:preview|production)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable=()=>new HttpError(503,'Photo storage is temporarily unavailable. Your credits are safe.','STORAGE_UNAVAILABLE');

// Private bucket only. The application assigns opaque immutable object keys.
// Signing credentials, the bucket and account identifier never come from a request.
export function r2Store(env,{fetcher=fetch,now=Date.now}={}) {
  if(!/^[a-f0-9]{32}$/.test(env.PF_R2_ACCOUNT_ID||'')||!/^premiereflow-[a-z0-9-]{3,48}$/.test(env.PF_R2_BUCKET||'')||
    !/^[A-Za-z0-9]{20,128}$/.test(env.PF_R2_ACCESS_KEY_ID||'')||!env.PF_R2_SECRET_ACCESS_KEY||env.PF_R2_SECRET_ACCESS_KEY.length<32)
    throw new Error('Private R2 storage is not configured');
  const namespace=env.VERCEL_ENV==='production'?'production':'preview';
  const prefix='v1/'+namespace+'/';
  const origin='https://'+env.PF_R2_ACCOUNT_ID+'.r2.cloudflarestorage.com';
  const signer=new AwsClient({accessKeyId:env.PF_R2_ACCESS_KEY_ID,secretAccessKey:env.PF_R2_SECRET_ACCESS_KEY,service:'s3',region:'auto',retries:0});
  function objectUrl(key) {
    if(typeof key!=='string'||!keyPattern.test(key)||!key.startsWith(prefix)) throw new HttpError(400,'Invalid stored photo.','STORAGE_KEY_INVALID');
    return new URL('/'+env.PF_R2_BUCKET+'/'+key,origin);
  }
  const date=()=>new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,'');
  async function sign(key,method,headers={},expiry=300,query={}) {
    if(!Number.isInteger(expiry)||expiry<1||expiry>900) throw new Error('Invalid storage access lifetime');
    const url=objectUrl(key);
    for(const [name,value] of Object.entries(query))url.searchParams.set(name,value);
    url.searchParams.set('X-Amz-Expires',String(expiry));
    const signed=await signer.sign(url,{method,headers,aws:{signQuery:true,allHeaders:true,datetime:date()}});
    return {url:signed.url,headers:Object.fromEntries(signed.headers),expiresAt:now()+expiry*1000};
  }
  async function upload(key,{mime,bytes}) {
    if(!types.has(mime)||!Number.isSafeInteger(bytes)||bytes<1||bytes>30_000_000) throw new HttpError(400,'Choose a supported photo up to 30 MB.','UPLOAD_INVALID');
    // The signature binds length/type and a create-only condition. A valid upload
    // URL cannot overwrite a file after it has passed verification.
    return sign(key,'PUT',{'Content-Type':mime,'Content-Length':String(bytes),'If-None-Match':'*'});
  }
  async function download(key,{attachment=false,filename='image.jpg',expiry=300}={}) {
    const safe=String(filename).replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120)||'image.jpg';
    return sign(key,'GET',{},expiry,attachment?{'response-content-disposition':'attachment; filename="'+safe+'"'}:{});
  }
  async function request(key,method) {
    const signed=await signer.sign(objectUrl(key),{method,aws:{datetime:date()}});
    try {
      const response=await fetcher(signed,{redirect:'error',signal:AbortSignal.timeout(10000)});
      if(response.status===404)throw new HttpError(409,'This photo has not finished uploading.','UPLOAD_PENDING');
      if(!response.ok)throw unavailable();
      return response;
    } catch(error) {if(error instanceof HttpError)throw error;throw unavailable();}
  }
  async function head(key) {
    const response=await request(key,'HEAD');
    const bytes=Number(response.headers.get('content-length'));
    const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>30_000_000||!types.has(mime)||!response.headers.get('etag'))throw new HttpError(400,'The uploaded photo has an unsupported format or size.','UPLOAD_INVALID');
    return {bytes,mime,etag:response.headers.get('etag')||''};
  }
  async function read(key,{maxBytes=30_000_000}={}) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>30_000_000)throw new Error('Invalid read limit');
    const response=await request(key,'GET');
    const length=Number(response.headers.get('content-length'));
    if(length>maxBytes){await response.body?.cancel();throw new HttpError(400,'The photo exceeds the allowed size.','UPLOAD_INVALID');}
    const reader=response.body?.getReader();if(!reader)throw unavailable();
    const chunks=[];let total=0;
    try {
      for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new HttpError(400,'The photo exceeds the allowed size.','UPLOAD_INVALID');}chunks.push(value);}
    }catch(error){if(error instanceof HttpError)throw error;throw unavailable();}
    return {body:Buffer.concat(chunks),mime:(response.headers.get('content-type')||'').split(';')[0].toLowerCase(),etag:response.headers.get('etag')||''};
  }
  return {prefix,upload,download,head,read};
}
