import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {HttpError} from './http.mjs';

const publicKey='64387322e1e85c547e9c';
const cdn='https://5zzyp2gsg2.ucarecd.net';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const filePattern=new RegExp('^/'+uuid+'/$');
const logoPattern=new RegExp('^/('+uuid+')/(?:-/crop/[1-9][0-9]{0,4}x[1-9][0-9]{0,4}/[0-9]{1,5},[0-9]{1,5}/)?(?:-/preview/)?$');
const groupPattern=new RegExp('^/('+uuid+'~([1-9]|10))/$');
const denied=()=>new HttpError(403,'These photos could not be verified as your uploads. Upload them again from your account.','UPLOAD_NOT_OWNED');
const unavailable=()=>new HttpError(503,'Image storage could not confirm your upload. Please try again.','UPLOAD_UNAVAILABLE');

// This proof grants no account/API access. The uploader puts it in file metadata;
// the server reads it back from Uploadcare, never from a submission body. Metadata
// on an existing file can only be changed through the credentialed REST API.
// Purpose-separated keys keep this distinct from authentication/session tokens.
export function uploadOwnership(secret,{fetcher=fetch,now=Date.now}={}) {
  if(typeof secret!=='string'||secret.length<32) throw new Error('Upload ownership key is unavailable');
  const key=createHmac('sha256',secret).update('premiereflow/upload-ownership/v1').digest();
  const mac=value=>createHmac('sha256',key).update(value).digest('base64url');
  const owner=account=>{
    if(!account?.accountId||!account?.userId) throw denied();
    return mac('owner:'+JSON.stringify([account.accountId,account.userId]));
  };
  function issue(account) {
    const expiresAt=now()+4*60*60*1000;
    const data=Buffer.from(JSON.stringify({o:owner(account),e:expiresAt,n:randomBytes(16).toString('base64url')})).toString('base64url');
    return {metadata:{pf_owner:data+'.'+mac(data)},expiresAt};
  }
  function matches(account,proof) {
    if(typeof proof!=='string'||proof.length>512) return false;
    const [data,signature,...extra]=proof.split('.');
    if(extra.length||!data||!signature||!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expected=mac(data);
    if(!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return false;
    try {
      const claims=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));
      return claims.o===owner(account)&&Number.isSafeInteger(claims.e)&&claims.e>now()&&claims.e<=now()+4*60*60*1000&&typeof claims.n==='string';
    } catch {return false;}
  }
  function url(value,group=false) {
    let parsed;try{parsed=new URL(value);}catch{throw denied();}
    if(parsed.origin!==cdn||parsed.username||parsed.password||parsed.search||parsed.hash||!(group?groupPattern:filePattern).test(parsed.pathname)) throw denied();
    return parsed;
  }
  async function info(path,params) {
    const target=new URL(path,'https://upload.uploadcare.com');
    target.search=new URLSearchParams({pub_key:publicKey,...params}).toString();
    try {
      const response=await fetcher(target,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
      if(!response.ok) throw unavailable();
      const reader=response.body.getReader(),chunks=[];let size=0;
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144){await reader.cancel();throw unavailable();}chunks.push(part.value);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {throw unavailable();}
  }
  async function verifyFile(account,fileId) {
    const file=await info('/info/',{file_id:fileId});
    if(file.uuid!==fileId||file.is_image!==true||file.is_ready!==true||file.is_stored!==true||!matches(account,file.metadata?.pf_owner)) throw denied();
    if(!Number.isSafeInteger(file.size)||file.size<1||file.size>30_000_000||!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.mime_type)) throw new HttpError(400,'Upload a supported vehicle image up to 30 MB.','UPLOAD_INVALID');
    return file;
  }
  async function file(account,value) {
    let parsed;try{parsed=new URL(value);}catch{throw denied();}
    const match=parsed.pathname.match(logoPattern);
    if(parsed.origin!==cdn||parsed.username||parsed.password||parsed.search||parsed.hash||!match) throw denied();
    const id=match[1];
    await verifyFile(account,id);
    return parsed.href;
  }
  async function group(account,value,thumbnail='') {
    const parsed=url(value,true),[,id,countText]=parsed.pathname.match(groupPattern),count=Number(countText);
    const group=await info('/group/info/',{group_id:id});
    if(group.id!==id||group.files_count!==count||!Array.isArray(group.files)||group.files.length!==count) throw denied();
    const ids=group.files.map(entry=>entry?.uuid);
    if(ids.some(id=>typeof id!=='string'||!new RegExp('^'+uuid+'$').test(id))||new Set(ids).size!==count) throw denied();
    // At most four bounded waves for ten images; no arbitrary URL fetches.
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(3,count)},async()=>{while(cursor<count) await verifyFile(account,ids[cursor++]);}));
    let cover=cdn+'/'+ids[0]+'/';
    if(thumbnail) {
      const selected=url(thumbnail);
      if(!ids.includes(selected.pathname.slice(1,-1))) throw denied();
      cover=selected.href;
    }
    return {uploadcareUrl:parsed.href,thumbnail:cover,fileIds:ids};
  }
  return {issue,matches,file,group};
}
