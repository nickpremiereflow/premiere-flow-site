import {randomUUID,createHash} from 'node:crypto';
import {transaction} from './database.mjs';
import {canonical,digest} from './repository.mjs';
import {HttpError,onlyKeys} from './http.mjs';
import {imagePreflight} from './listing-import.mjs';
import {readPublicResource} from './public-resource.mjs';
import {MEDIA_ID,mediaGroupUrl,parseMediaUrl,uploadManifest,generatedSize} from './media-contract.mjs';

const denied=()=>new HttpError(404,'Photo package not found.','MEDIA_NOT_FOUND');
const conflict=()=>new HttpError(409,'This photo package has already changed. Refresh before trying again.','MEDIA_CONFLICT');
const mimeExtension=mime=>({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'}[mime]||'jpg');

export function mediaService(database,store,baseURL,{now=Date.now,readLegacy=readPublicResource}={}) {
 const namespace=store.prefix.split('/')[1];
 if(!['production','preview'].includes(namespace))throw new Error('Invalid media namespace');
 const accountId=account=>{if(!account?.accountId||!account?.userId)throw denied();return account.accountId;};
 const objects=async(client,id)=>(await client.query('SELECT * FROM pf_media_object WHERE group_id=$1 ORDER BY ordinal,role',[id])).rows;
 async function groupRow(client,id,owner,{lock=false}={}) {
  const {rows:[group]}=await client.query('SELECT * FROM pf_media_group WHERE group_id=$1 AND account_id=$2 AND namespace=$3'+(lock?' FOR UPDATE':''),[id,owner,namespace]);
  if(!group)throw denied();return group;
 }
 async function allocate(client,bytes) {
  const {rowCount}=await client.query(`UPDATE pf_media_budget SET allocated_bytes=allocated_bytes+$2,updated_at=now()
    WHERE namespace=$1 AND allocated_bytes+$2<=limit_bytes`,[namespace,bytes]);
  if(!rowCount)throw new HttpError(503,'New uploads are temporarily paused while storage capacity is reviewed. Existing images and credits are safe.','STORAGE_CAPACITY');
 }
 async function addObject(client,group,role,ordinal,mime,bytes,name='') {
  const id=randomUUID(),key=store.prefix+id;
  const {rows:[row]}=await client.query(`INSERT INTO pf_media_object(object_id,group_id,account_id,role,ordinal,object_key,original_name,declared_mime,allocated_bytes,upload_expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 minutes') RETURNING *`,[id,group.group_id,group.account_id,role,ordinal,key,name,mime,bytes]);
  return row;
 }
 async function uploadAccess(row) {
  if(row.state==='verified')return {objectId:row.object_id,role:row.role,ordinal:row.ordinal,verified:true};
  if(Date.parse(row.upload_expires_at)<=now())throw new HttpError(409,'This upload expired. Choose the photos again.','UPLOAD_EXPIRED');
  return {objectId:row.object_id,role:row.role,ordinal:row.ordinal,mime:row.declared_mime,bytes:Number(row.allocated_bytes),...await store.upload(row.object_key,{mime:row.declared_mime,bytes:Number(row.allocated_bytes)})};
 }
 async function prepareUpload(account,input) {
  const owner=accountId(account),manifest=uploadManifest(input),fingerprint=digest(canonical(manifest));
  const result=await transaction(database,async client=>{
   // Serialize this account's repeated requests before creating a group/budget.
   await client.query('SELECT account_id FROM pf_customer WHERE account_id=$1 FOR UPDATE',[owner]);
   const {rows:[existing]}=await client.query('SELECT * FROM pf_media_group WHERE group_id=$1 FOR UPDATE',[manifest.requestId]);
   if(existing){if(existing.account_id!==owner||existing.namespace!==namespace||existing.fingerprint!==fingerprint)throw conflict();return {group:existing,files:await objects(client,existing.group_id)};}
   await allocate(client,manifest.totalBytes);
   const group={group_id:manifest.requestId,account_id:owner};
   const url=mediaGroupUrl(baseURL,group.group_id,manifest.files.length);
   const {rows:[created]}=await client.query(`INSERT INTO pf_media_group(group_id,account_id,namespace,kind,expected_files,canonical_url,fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[group.group_id,owner,namespace,manifest.kind,manifest.files.length,url,fingerprint]);
   const files=[];
   for(const f of manifest.files){files.push(await addObject(client,group,manifest.kind,f.ordinal,f.mime,f.bytes,f.name));if(manifest.kind==='source')files.push(await addObject(client,group,'source_preview',f.ordinal,'image/jpeg',f.previewBytes,f.name));}
   return {group:created,files};
  });
  return {groupId:result.group.group_id,groupUrl:result.group.canonical_url,state:result.group.state,files:await Promise.all(result.files.map(uploadAccess))};
 }
 async function verifyRow(row) {
  if(row.state==='verified')return row;
  const meta=await store.head(row.object_key);
  if(meta.bytes!==Number(row.allocated_bytes)||meta.mime!==row.declared_mime)throw new HttpError(400,'The uploaded file differs from the selected photo.','UPLOAD_INVALID');
  const content=await store.read(row.object_key,{maxBytes:Number(row.allocated_bytes)});
  if(content.body.length!==Number(row.allocated_bytes)||content.mime!==row.declared_mime||content.etag!==meta.etag)throw conflict();
  let valid;
  if(row.role==='source'&&['image/heic','image/heif'].includes(row.declared_mime)){
   valid=content.body.length>=24&&content.body.toString('ascii',4,8)==='ftyp'&&/heic|heix|hevc|hevx|mif1|msf1/.test(content.body.toString('ascii',8,48));
  }else valid=imagePreflight(content.body,content.mime,row.role==='logo'?{minLongEdge:32,minShortEdge:16,maxAspect:30}:undefined).accepted;
  if(!valid)throw new HttpError(400,'This photo could not be verified. Choose a clear, full-size JPEG, PNG, WebP or supported phone photo.','UPLOAD_INVALID');
  const sha=createHash('sha256').update(content.body).digest('hex');
  const {rows:[verified]}=await database.query(`UPDATE pf_media_object SET state='verified',byte_size=$2,sha256=$3,etag=$4,verified_at=now()
    WHERE object_id=$1 AND state='allocated' RETURNING *`,[row.object_id,meta.bytes,sha,meta.etag]);
  if(verified)return verified;
  const {rows:[current]}=await database.query('SELECT * FROM pf_media_object WHERE object_id=$1',[row.object_id]);
  if(current?.state!=='verified'||current.sha256!==sha)throw conflict();return current;
 }
 async function verifyUpload(account,id) {
  if(!MEDIA_ID.test(id||''))throw denied();
  const {rows:[row]}=await database.query(`SELECT o.* FROM pf_media_object o JOIN pf_media_group g ON g.group_id=o.group_id
    WHERE o.object_id=$1 AND o.account_id=$2 AND g.namespace=$3 AND g.kind IN ('source','logo')`,[id,accountId(account),namespace]);
  if(!row)throw denied();const verified=await verifyRow(row);return {verified:true,objectId:id,bytes:Number(verified.byte_size)};
 }
 function completeObjects(group,files) {
  const primary=files.filter(f=>f.role===group.kind);
  if(primary.length!==group.expected_files||primary.some((f,i)=>f.ordinal!==i||f.state!=='verified'))throw conflict();
  if(group.kind==='source'){
   const previews=files.filter(f=>f.role==='source_preview');
   if(previews.length!==group.expected_files||previews.some((f,i)=>f.ordinal!==i||f.state!=='verified'||f.declared_mime!=='image/jpeg'))throw conflict();
  }
  return primary;
 }
 async function sealUpload(account,id) {
  if(!MEDIA_ID.test(id||''))throw denied();
  return transaction(database,async client=>{
   const group=await groupRow(client,id,accountId(account),{lock:true});if(!['source','logo'].includes(group.kind))throw denied();
   completeObjects(group,await objects(client,id));
   await client.query("UPDATE pf_media_group SET state='sealed',sealed_at=COALESCE(sealed_at,now()) WHERE group_id=$1",[id]);
   return {groupUrl:group.canonical_url,thumbnail:group.canonical_url+'nth/0/',files:group.expected_files};
  });
 }
 async function ownedGroup(account,value,kind) {
  const parsed=parseMediaUrl(baseURL,value,{group:true});
  const group=await groupRow(database,parsed.groupId,accountId(account));
  if(group.state!=='sealed'||group.canonical_url!==parsed.url||group.expected_files!==parsed.count||(kind&&group.kind!==kind))throw denied();
  const files=await objects(database,group.group_id);completeObjects(group,files);return {group,files};
 }
 async function group(account,value,thumbnail='') {
  const {group:g,files}=await ownedGroup(account,value,'source');
  if(thumbnail){const t=parseMediaUrl(baseURL,thumbnail);if(t.groupId!==g.group_id||t.count!==g.expected_files)throw denied();}
  return {uploadcareUrl:g.canonical_url,thumbnail:thumbnail||g.canonical_url+'nth/0/',fileIds:files.filter(f=>f.role==='source').map(f=>f.object_id)};
 }
 async function file(account,value) {
  const p=parseMediaUrl(baseURL,value);await ownedGroup(account,mediaGroupUrl(baseURL,p.groupId,p.count),'logo');return p.url;
 }
 async function assetAccess(account,value,{attachment=false,original=false}={}) {
  const p=parseMediaUrl(baseURL,value),{group:g,files}=await ownedGroup(account,mediaGroupUrl(baseURL,p.groupId,p.count));
  const role=g.kind==='source'&&!original?'source_preview':g.kind;
  const row=files.find(f=>f.role===role&&f.ordinal===p.ordinal);if(!row)throw denied();
  return store.download(row.object_key,{attachment,filename:(g.kind==='generated'?'staged-':'photo-')+(p.ordinal+1)+'.'+mimeExtension(row.declared_mime)});
 }
 async function downloadManifest(account,value) {
  const {group:g,files}=await ownedGroup(account,value);
  return {count:g.expected_files,files:await Promise.all(files.filter(f=>f.role===g.kind).map(async row=>({name:'image-'+(row.ordinal+1)+'.'+mimeExtension(row.declared_mime),bytes:Number(row.byte_size),...await store.download(row.object_key,{attachment:true,expiry:900,filename:'image-'+(row.ordinal+1)+'.'+mimeExtension(row.declared_mime)})})))};
 }
 async function engineContext(ticket,jobId,attempt) {
  if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket)||!MEDIA_ID.test(jobId||'')||!Number.isInteger(attempt)||attempt<1||attempt>3)throw denied();
  const {rows:[job]}=await database.query(`SELECT j.* FROM pf_job j JOIN pf_engine_dispatch d ON d.job_id=j.job_id AND d.account_id=j.account_id
   WHERE j.job_id=$1 AND j.attempt_count=$2 AND d.attempt=$2 AND d.claimed_ticket_hash=$3 AND d.state='claimed'
    AND j.status='PROCESSING' AND d.claimed_at>now()-interval '2 hours'`,[jobId,attempt,digest(ticket)]);
  if(!job)throw denied();return job;
 }
 async function engineMedia(input) {
  onlyKeys(input,['ticket','jobId','attempt','action','ordinal','mime','encodedLength','tail','objectId','files','groupId']);
  const job=await engineContext(input.ticket,input.jobId,input.attempt),owner=job.account_id;
  if(input.action==='sources'||input.action==='source'){
   // Read-only compatibility for same-job retries using historical source photos.
   // Never uploads, copies, deletes or changes any historical Uploadcare file.
   const legacy=String(job.source_url||'').match(/^https:\/\/5zzyp2gsg2\.ucarecd\.net\/([0-9a-f-]{36}~(?:[1-9]|10))\/$/);
   if(legacy){
    const target='https://upload.uploadcare.com/group/info/?pub_key=64387322e1e85c547e9c&group_id='+legacy[1];
    const response=await readLegacy(target,{maxBytes:65536,timeoutMs:8000,beforeRequest:async u=>{if(u.href!==target)throw denied();}});
    let data;try{data=JSON.parse(response.body.toString());}catch{throw conflict();}
    if(response.status!==200||!Array.isArray(data.files)||data.files.length!==job.expected_images||data.files.some(f=>!MEDIA_ID.test(f.uuid||'')))throw conflict();
    if(input.action==='sources')return {id:legacy[1],files:data.files.map((f,ordinal)=>({uuid:f.uuid,ordinal}))};
    if(!Number.isInteger(input.ordinal)||input.ordinal<0||input.ordinal>=data.files.length)throw denied();
    return {sourceUrl:'https://5zzyp2gsg2.ucarecd.net/'+data.files[input.ordinal].uuid+'/-/preview/1920x1080/-/format/jpeg/-/quality/lightest/image.jpg'};
   }
   const p=parseMediaUrl(baseURL,job.source_url,{group:true}),g=await groupRow(database,p.groupId,owner),files=await objects(database,p.groupId);
   if(g.kind!=='source'||g.state!=='sealed'||g.expected_files!==job.expected_images||g.canonical_url!==job.source_url)throw denied();completeObjects(g,files);
   const previews=files.filter(f=>f.role==='source_preview');
   if(input.action==='sources')return {id:g.group_id,files:previews.map(f=>({uuid:f.object_id,ordinal:f.ordinal}))};
   if(!Number.isInteger(input.ordinal)||input.ordinal<0||input.ordinal>=g.expected_files)throw denied();
   const f=previews.find(f=>f.ordinal===input.ordinal);
   // Sign immediately before this image is processed, not once for the entire
   // sequential batch; later images must not inherit expired URLs.
   return {sourceUrl:(await store.download(f.object_key,{attachment:true,filename:'source-'+(f.ordinal+1)+'.jpg'})).url};
  }
  if(input.action==='prepare'){
   const size=generatedSize(input.encodedLength,input.tail);
   if(!['image/jpeg','image/png','image/webp'].includes(input.mime)||!Number.isInteger(input.ordinal)||input.ordinal<0||input.ordinal>=job.expected_images)throw conflict();
   const row=await transaction(database,async client=>{
    await client.query('SELECT account_id FROM pf_customer WHERE account_id=$1 FOR UPDATE',[owner]);
    // Recheck after taking the same leading account lock used by completion.
    const {rowCount}=await client.query(`SELECT 1 FROM pf_engine_dispatch d JOIN pf_job j ON j.job_id=d.job_id
      WHERE d.job_id=$1 AND d.attempt=$2 AND d.claimed_ticket_hash=$3 AND d.state='claimed' AND j.status='PROCESSING' AND j.attempt_count=$2
        AND d.claimed_at>now()-interval '2 hours'`,[job.job_id,input.attempt,digest(input.ticket)]);
    if(!rowCount)throw denied();
    let {rows:[g]}=await client.query("SELECT * FROM pf_media_group WHERE job_id=$1 AND attempt=$2 AND kind='generated' FOR UPDATE",[job.job_id,input.attempt]);
    if(!g){const id=randomUUID();({rows:[g]}=await client.query(`INSERT INTO pf_media_group(group_id,account_id,namespace,kind,expected_files,canonical_url,fingerprint,job_id,attempt)
      VALUES($1,$2,$3,'generated',$4,$5,$6,$7,$8) RETURNING *`,[id,owner,namespace,job.expected_images,mediaGroupUrl(baseURL,id,job.expected_images),digest('generated:'+job.job_id+':'+input.attempt),job.job_id,input.attempt]));}
    if(g.state!=='uploading')throw conflict();
    const {rows:[existing]}=await client.query("SELECT * FROM pf_media_object WHERE group_id=$1 AND role='generated' AND ordinal=$2",[g.group_id,input.ordinal]);
    if(existing){if(existing.declared_mime!==input.mime||Number(existing.allocated_bytes)!==size)throw conflict();return existing;}
    await allocate(client,size);return addObject(client,g,'generated',input.ordinal,input.mime,size);
   });
   return {file:row.object_id,...await uploadAccess(row)};
  }
  if(input.action==='verify'){
   if(!MEDIA_ID.test(input.objectId||''))throw denied();
   const {rows:[row]}=await database.query(`SELECT o.* FROM pf_media_object o JOIN pf_media_group g ON g.group_id=o.group_id
    WHERE o.object_id=$1 AND g.account_id=$2 AND g.job_id=$3 AND g.attempt=$4 AND g.namespace=$5 AND o.role='generated'`,[input.objectId,owner,job.job_id,input.attempt,namespace]);
   if(!row)throw denied();const verified=await verifyRow(row);
   return {uuid:verified.object_id,is_stored:true,is_ready:true,is_image:true,readUrl:(await store.download(verified.object_key,{attachment:true,filename:'staged.'+mimeExtension(verified.declared_mime)})).url};
  }
  if(input.action==='seal'||input.action==='group'){
   const {rows:[g]}=await database.query("SELECT * FROM pf_media_group WHERE account_id=$1 AND job_id=$2 AND attempt=$3 AND kind='generated' AND namespace=$4",[owner,job.job_id,input.attempt,namespace]);
   if(!g)throw denied();const files=completeObjects(g,await objects(database,g.group_id));
   if(input.action==='seal'){
    if(!Array.isArray(input.files)||input.files.length!==g.expected_files||input.files.some((id,i)=>id!==files[i].object_id))throw conflict();
    await database.query("UPDATE pf_media_group SET state='sealed',sealed_at=COALESCE(sealed_at,now()) WHERE group_id=$1",[g.group_id]);
   }else if(g.state!=='sealed'||input.groupId!==g.group_id)throw denied();
   return {id:g.group_id,cdn_url:g.canonical_url,files:files.map(f=>({uuid:f.object_id,ordinal:f.ordinal}))};
  }
  throw new HttpError(400,'Unknown media operation.','MEDIA_INVALID');
 }
 async function verifyResult(ticket,result,expectedImages) {
  const job=await engineContext(ticket,result.jobId,result.attempt),p=parseMediaUrl(baseURL,result.outputUrl,{group:true});
  const g=await groupRow(database,p.groupId,job.account_id);
  if(g.kind!=='generated'||g.state!=='sealed'||g.job_id!==result.jobId||g.attempt!==result.attempt||g.expected_files!==expectedImages||g.canonical_url!==result.outputUrl)throw denied();
  const files=completeObjects(g,await objects(database,g.group_id)),assets=[];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(2,files.length)},async()=>{while(cursor<files.length){const f=files[cursor++],meta=await store.head(f.object_key);if(meta.etag!==f.etag||meta.bytes!==Number(f.byte_size)||meta.mime!==f.declared_mime)throw conflict();assets.push({ordinal:f.ordinal,url:g.canonical_url+'nth/'+f.ordinal+'/',mimeType:f.declared_mime,byteSize:Number(f.byte_size),sha256:f.sha256});}}));
  return assets.sort((a,b)=>a.ordinal-b.ordinal);
 }
 return {issue:()=>({provider:'r2',maximumFiles:10,maximumFileBytes:30000000}),prepareUpload,verifyUpload,sealUpload,group,file,assetAccess,downloadManifest,engineMedia,verifyResult};
}
