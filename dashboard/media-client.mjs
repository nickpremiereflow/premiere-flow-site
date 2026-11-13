// Private-media browser adapter. No storage credentials or public bucket access.
const MAX_FILE=30_000_000,MAX_ZIP=120_000_000;
const extensions={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
export function photoMime(file){return file.type||extensions[file.name.split('.').pop().toLowerCase()]||'';}
export async function jpegPreview(file){
 const url=URL.createObjectURL(file),image=new Image();
 try {
  image.src=url;await image.decode();
  const width=image.naturalWidth,height=image.naturalHeight;
  if(!width||!height||width*height>50_000_000)throw new Error('Choose a photo up to 50 megapixels.');
  const scale=Math.min(1,1920/Math.max(width,height)),canvas=document.createElement('canvas');
  canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));
  if(!result||result.size>5_000_000)throw new Error('The photo preview is too large. Choose a smaller photo.');
  return result;
 }catch(error){if(error.message?.startsWith('Choose')||error.message?.startsWith('The photo'))throw error;throw new Error('This browser cannot read that photo. For HEIC photos, use Safari on your iPhone or export JPEG first. No credit was used.');}
 finally{URL.revokeObjectURL(url);}
}
export async function uploadFiles(files,{kind='source',request,progress=()=>{},fetcher=fetch}={}){
 const selected=Array.from(files);
 if(selected.length<1||selected.length>(kind==='logo'?1:10))throw new Error(kind==='logo'?'Choose one logo.':'Choose 1–10 photos.');
 for(const f of selected)if(f.size<1||f.size>MAX_FILE||!Object.values(extensions).includes(photoMime(f)))throw new Error('Choose JPEG, PNG, WebP or supported phone photos up to 30 MB each.');
 const previews=[];
 if(kind==='source')for(let i=0;i<selected.length;i++){progress('Preparing photo '+(i+1)+' of '+selected.length+'…');previews.push(await jpegPreview(selected[i]));}
 const manifest=selected.map((f,i)=>({name:f.name.slice(0,180),mime:photoMime(f),bytes:f.size,...(kind==='source'?{previewBytes:previews[i].size}:{})}));
 const prepared=await request('/api/uploads/prepare',{requestId:crypto.randomUUID(),kind,files:manifest});
 for(let i=0;i<prepared.files.length;i++){
  const target=prepared.files[i],body=target.role==='source_preview'?previews[target.ordinal]:selected[target.ordinal];
  progress('Uploading '+(i+1)+' of '+prepared.files.length+'…');
  if(!target.verified){
   const headers={...target.headers};delete headers['content-length']; // Browser binds the actual Blob length.
   let response;
   try{response=await fetcher(target.url,{method:'PUT',credentials:'omit',headers,body,signal:AbortSignal.timeout(120000)});}catch{throw new Error('Photo upload was interrupted. Choose the same photos again. No listing credit was used.');}
   if(!response.ok&&response.status!==412)throw new Error('Photo upload could not finish. No listing credit was used.');
   await request('/api/uploads/verify',{objectId:target.objectId});
  }
 }
 progress('Verifying photo package…');
 return request('/api/uploads/seal',{groupId:prepared.groupId});
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function record(size){const bytes=new Uint8Array(size),v=new DataView(bytes.buffer);return {bytes,u16:(o,n)=>v.setUint16(o,n,true),u32:(o,n)=>v.setUint32(o,n,true)};}
// ZIP STORE: images are already compressed. No recompression or third-party upload.
export function zipFromFiles(files){
 if(!files.length||files.length>10||files.reduce((n,f)=>n+f.bytes.byteLength,0)>MAX_ZIP)throw new Error('This package is too large for a browser ZIP. Download images individually.');
 const parts=[],central=[];let offset=0,centralSize=0;
 files.forEach((file,i)=>{
  const safe=String(file.name).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'image-'+(i+1),name=new TextEncoder().encode(safe),size=file.bytes.byteLength,crc=crc32(file.bytes);
  const local=record(30);local.u32(0,0x04034b50);local.u16(4,20);local.u16(6,0x800);local.u16(12,33);local.u32(14,crc);local.u32(18,size);local.u32(22,size);local.u16(26,name.length);
  parts.push(local.bytes,name,file.bytes);
  const directory=record(46);directory.u32(0,0x02014b50);directory.u16(4,20);directory.u16(6,20);directory.u16(8,0x800);directory.u16(14,33);directory.u32(16,crc);directory.u32(20,size);directory.u32(24,size);directory.u16(28,name.length);directory.u32(42,offset);
  central.push(directory.bytes,name);centralSize+=46+name.length;offset+=30+name.length+size;
 });
 const end=record(22);end.u32(0,0x06054b50);end.u16(8,files.length);end.u16(10,files.length);end.u32(12,centralSize);end.u32(16,offset);
 return new Blob([...parts,...central,end.bytes],{type:'application/zip'});
}
export async function downloadPackage(groupUrl,name,{progress=()=>{},fetcher=fetch}={}){
 const u=new URL(groupUrl,location.origin);
 if(u.origin!==location.origin||!/^\/api\/media\/groups\/[0-9a-f-]{36}~(?:[1-9]|10)\/$/.test(u.pathname)||u.search||u.hash)throw new Error('Invalid photo package.');
 const response=await fetcher(u,{credentials:'same-origin',cache:'no-store'}),manifest=await response.json();
 if(!response.ok)throw new Error(manifest.error||'Your download could not be authorized. Sign in again.');
 if(!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>10||manifest.files.some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>MAX_FILE)||manifest.files.reduce((n,f)=>n+f.bytes,0)>MAX_ZIP)throw new Error('This package is too large for a browser ZIP. Download images individually.');
 const files=[];
 for(let i=0;i<manifest.files.length;i++){
  const f=manifest.files[i],url=new URL(f.url);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.r2.cloudflarestorage.com'))throw new Error('Invalid photo download.');
  progress('Preparing '+(i+1)+' of '+manifest.files.length+'…');
  const item=await fetcher(url,{credentials:'omit',signal:AbortSignal.timeout(60000)});
  if(!item.ok)throw new Error('A photo could not be downloaded. Try again.');
  const reader=item.body.getReader(),chunks=[];let total=0;
  for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>f.bytes){await reader.cancel();throw new Error('The photo size could not be verified.');}chunks.push(value);}
  if(total!==f.bytes)throw new Error('The photo download was incomplete. Try again.');
  const bytes=new Uint8Array(total);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.byteLength;}files.push({name:f.name,bytes});
 }
 return {blob:zipFromFiles(files),filename:(String(name).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100)||'premiereflow')+'.zip'};
}
