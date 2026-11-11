import {canonical,digest} from './repository.mjs';
import {HttpError,onlyKeys,shortText} from './http.mjs';
import {JOB_ID_PATTERN} from './access.mjs';
import {readPublicResource} from './public-resource.mjs';
import {imagePreflight} from './listing-import.mjs';

const storageHost='5zzyp2gsg2.ucarecd.net';
const invalid=()=>new HttpError(400,'The engine result is invalid.','RESULT_INVALID');
const denied=()=>new HttpError(403,'Result authorization failed.','INVALID_TICKET');
const conflict=()=>new HttpError(409,'This attempt already has a different result.','RESULT_CONFLICT');

export function engineResult(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw invalid();
  onlyKeys(input,['jobId','attempt','status','outputUrl','qaStatus','qaNotes','errorStage','errorCode','errorDetails','nextRetryAt']);
  if(!JOB_ID_PATTERN.test(input.jobId||'')||!Number.isInteger(input.attempt)||input.attempt<1||input.attempt>3||!['COMPLETED','FAILED','RETRY_REQUIRED'].includes(input.status)) throw invalid();
  const text=(value,max)=>value==null||value===''?'':shortText(value,max,'Result text');
  // Provider diagnostics must not persist API keys, bearer credentials or URL queries.
  const sanitize=value=>text(value,4000).replace(/\b(?:Bearer\s+\S+|AIza[A-Za-z0-9_-]+|(?:sk|rk)_(?:live|test)_\S+|whsec_\S+)/gi,'[redacted]').replace(/(https?:\/\/[^\s?#]+)[?#]\S+/gi,'$1?[redacted]');
  const result={jobId:input.jobId.toLowerCase(),attempt:input.attempt,status:input.status,outputUrl:'',qaStatus:input.qaStatus||'PENDING',qaNotes:sanitize(input.qaNotes),errorStage:'',errorCode:'',errorDetails:'',nextRetryAt:null};
  if(!['PENDING','PASS','FAIL','REVIEW'].includes(result.qaStatus)) throw invalid();
  if(result.status==='COMPLETED') {
    let url;try{url=new URL(input.outputUrl);}catch{throw invalid();}
    if(url.protocol!=='https:'||url.hostname!==storageHost||url.port||url.username||url.password||url.search||url.hash||!/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}~(?:[1-9]|10)\/$/.test(url.pathname)||result.qaStatus!=='PASS'||input.errorStage||input.errorCode||input.errorDetails||input.nextRetryAt) throw invalid();
    result.outputUrl=url.href;
  } else {
    if(input.outputUrl||result.qaStatus==='PASS') throw invalid();
    result.errorStage=shortText(input.errorStage,80,'Error stage');
    result.errorCode=shortText(input.errorCode,100,'Error code');
    if(!/^[A-Za-z0-9_. -]+$/.test(result.errorStage)||! /^[A-Za-z0-9_.-]+$/.test(result.errorCode)) throw invalid();
    result.errorDetails=sanitize(input.errorDetails);
    if(input.nextRetryAt) {
      if(result.status!=='RETRY_REQUIRED'||typeof input.nextRetryAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(input.nextRetryAt)||!Number.isFinite(Date.parse(input.nextRetryAt))) throw invalid();
      result.nextRetryAt=new Date(input.nextRetryAt).toISOString();
    }
    // A final failed attempt cannot advertise another automatic generation.
    if(result.attempt===3) {result.status='FAILED';result.nextRetryAt=null;}
  }
  return result;
}

// The callback is enabled only for isolated Preview acceptance. A claimed,
// attempt-bound ticket is required before any result may change job or credit state.
export function engineResults(database,{read=readPublicResource}={}) {
  return async function finish(token,input) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
    const result=engineResult(input), fingerprint=digest(canonical(result)), hash=digest(token);
    const {rows:[row]}=await database.query('SELECT pf_engine_result_context($1,$2,$3) AS result',[hash,result.jobId,result.attempt]);
    const context=row?.result;
    if(!context) throw denied();
    if(context.resultFingerprint) {
      if(context.resultFingerprint!==fingerprint) throw conflict();
      return {received:true,duplicate:true,jobId:result.jobId,status:context.status};
    }
    const assets=[];
    if(result.status==='COMPLETED') {
      const count=Number(result.outputUrl.match(/~(\d+)\/$/)[1]);
      if(count!==context.expectedImages) throw invalid();
      let cursor=0;
      // Two bounded reads at a time; ten images take at most five eight-second
      // waves, within the existing 60-second Function budget. No browser cookies.
      await Promise.all(Array.from({length:Math.min(2,count)},async()=>{
        while(cursor<count) {
          const ordinal=cursor++,url=result.outputUrl+'nth/'+ordinal+'/';
          let response;
          try {
            response=await read(url,{maxBytes:30_000_000,timeoutMs:8000,beforeRequest:async target=>{
              if(target.href!==url) throw new Error('Unexpected storage redirect');
            }});
          } catch {throw new HttpError(503,'The stored image could not be verified.','ASSET_UNAVAILABLE');}
          const mime=response.headers?.['content-type']||'';
          const checked=imagePreflight(response.body||Buffer.alloc(0),mime);
          if(response.status!==200||response.url!==url||!checked.accepted) throw new HttpError(503,'The stored image could not be verified.','ASSET_UNAVAILABLE');
          assets.push({ordinal,url,mimeType:checked.mime,byteSize:response.body.length,sha256:checked.sha256});
        }
      }));
      assets.sort((a,b)=>a.ordinal-b.ordinal);
    }
    try {
      const {rows:[completed]}=await database.query('SELECT pf_apply_engine_result($1,$2::jsonb,$3,$4::jsonb) AS result',[hash,JSON.stringify(result),fingerprint,JSON.stringify(assets)]);
      if(!completed?.result) throw denied();
      return completed.result;
    } catch(error) {
      if(error.message==='RESULT_CONFLICT') throw conflict();
      if(error.message==='RESULT_INVALID'||error.message==='DELIVERY_NOT_VERIFIED') throw invalid();
      throw error;
    }
  };
}
