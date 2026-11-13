import {HttpError,onlyKeys,shortText} from './http.mjs';

export const MEDIA_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const formats=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const invalid=()=>new HttpError(400,'Choose valid photos and try again.','MEDIA_INVALID');
export function mediaOrigin(baseURL) {
 const u=new URL(baseURL);
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('Invalid application media origin');
 return u.origin;
}
export function mediaGroupUrl(baseURL,id,count) {
 if(!MEDIA_ID.test(id)||!Number.isInteger(count)||count<1||count>10)throw invalid();
 return mediaOrigin(baseURL)+'/api/media/groups/'+id+'~'+count+'/';
}
export function parseMediaUrl(baseURL,value,{group=false}={}) {
 let u;try{u=new URL(value);}catch{throw invalid();}
 if(u.origin!==mediaOrigin(baseURL)||u.username||u.password||u.search||u.hash)throw invalid();
 const match=u.pathname.match(/^\/api\/media\/groups\/([0-9a-f-]{36})~([1-9]|10)\/(?:nth\/([0-9])\/)?$/);
 if(!match||!MEDIA_ID.test(match[1])||(group&&match[3]!==undefined)||(!group&&match[3]===undefined)||Number(match[3])>=Number(match[2]))throw invalid();
 return {groupId:match[1],count:Number(match[2]),ordinal:match[3]===undefined?null:Number(match[3]),url:u.href};
}
export function uploadManifest(input) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw invalid();
 onlyKeys(input,['requestId','kind','files']);
 if(!MEDIA_ID.test(input.requestId||'')||!['source','logo'].includes(input.kind)||!Array.isArray(input.files)||input.files.length<1||input.files.length>(input.kind==='logo'?1:10))throw invalid();
 const files=input.files.map((f,ordinal)=>{
  if(!f||typeof f!=='object'||Array.isArray(f))throw invalid();
  onlyKeys(f,input.kind==='source'?['name','mime','bytes','previewBytes']:['name','mime','bytes']);
  if(!formats.has(f.mime)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>30000000)throw invalid();
  if(input.kind==='logo'&&!['image/png','image/webp','image/jpeg'].includes(f.mime))throw invalid();
  if(input.kind==='source'&&(!Number.isSafeInteger(f.previewBytes)||f.previewBytes<1||f.previewBytes>5000000))throw invalid();
  return {ordinal,name:shortText(f.name,180,'File name').replace(/[\\/\u0000-\u001f\u007f]/g,'_'),mime:f.mime,bytes:f.bytes,...(input.kind==='source'?{previewBytes:f.previewBytes}:{})};
 });
 return {requestId:input.requestId,kind:input.kind,files,totalBytes:files.reduce((n,f)=>n+f.bytes+(f.previewBytes||0),0)};
}
export function generatedSize(encodedLength,tail) {
 if(!Number.isSafeInteger(encodedLength)||encodedLength<4||encodedLength%4||typeof tail!=='string'||!/^([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(tail))throw invalid();
 const size=encodedLength/4*3-(tail.endsWith('==')?2:tail.endsWith('=')?1:0);
 if(size<1||size>30000000)throw invalid();return size;
}
