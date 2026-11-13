import {createHash} from 'node:crypto';
import {HttpError} from './http.mjs';
import {publicURL,readPublicResource} from './public-resource.mjs';

const reject=(message,code='LISTING_IMPORT_REJECTED')=>new HttpError(422,message,code);
const text=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,160):'';
const asArray=value=>Array.isArray(value)?value:value==null?[]:[value];

function pathMatches(pattern,path) {
  const anchored=pattern.endsWith('$');if(anchored)pattern=pattern.slice(0,-1);
  let p=0,s=0,star=-1,retry=0,steps=0;
  while(s<path.length) {
    if(++steps>8192)return true; // A complicated restriction fails closed.
    if(p===pattern.length&&!anchored)return true;
    if(pattern[p]===path[s]){p++;s++;}
    else if(pattern[p]==='*'){star=p++;retry=s;}
    else if(star>=0){p=star+1;s=++retry;}
    else return false;
  }
  while(pattern[p]==='*')p++;
  return p===pattern.length;
}

// Deliberately limited to one explicitly identified vehicle. No gallery crawling,
// arbitrary page images, scripts, login walls, CAPTCHAs, or anti-bot workarounds.
export function extractVehicleListing(html,pageURL) {
  if(typeof html!=='string'||Buffer.byteLength(html)>2_000_000)throw reject('This page is too large to import. Upload photos instead.');
  const base=publicURL(pageURL);const vehicles=[];let scanned=0,cursor=0;
  const lower=html.toLowerCase();
  while(cursor<html.length) {
    const start=lower.indexOf('<script',cursor);if(start<0)break;
    const openingEnd=lower.indexOf('>',start+7);if(openingEnd<0)break;
    const closing=lower.indexOf('</script',openingEnd+1);if(closing<0)break;
    cursor=closing+8;
    const attributes=html.slice(start+7,openingEnd);
    if(attributes.length>8192||!/^\s/.test(attributes)||!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(attributes))continue;
    let document;try{document=JSON.parse(html.slice(openingEnd+1,closing));}catch{continue;}
    const stack=[document];
    while(stack.length) {
      if(++scanned>10_000) throw reject('This page is too complex to import. Upload photos instead.');
      const node=stack.pop();if(!node||typeof node!=='object')continue;
      if(asArray(node['@type']).some(type=>typeof type==='string'&&/^(?:(?:https?:\/\/)?schema\.org\/)?(?:Car|Vehicle|Motorcycle|BusOrCoach)$/.test(type))) vehicles.push(node);
      for(const value of Object.values(node))if(value&&typeof value==='object'){
        if(Array.isArray(value)&&value.length>10_000||stack.length>10_000)throw reject('This page is too complex to import. Upload photos instead.');
        for(const child of asArray(value))stack.push(child);
      }
    }
  }
  const distinct=new Map();
  for(const vehicle of vehicles) {
    const key=text(vehicle.vehicleIdentificationNumber)||text(vehicle['@id'])||JSON.stringify([vehicle.name,vehicle.image]);
    if(!distinct.has(key))distinct.set(key,vehicle);
  }
  if(distinct.size!==1) throw reject(distinct.size?'This page contains multiple vehicles. Open one vehicle listing or upload its photos.':'This site does not provide a supported vehicle listing. Upload the photos instead.','LISTING_NOT_SINGLE_VEHICLE');
  const vehicle=[...distinct.values()][0];const images=[];
  for(const item of asArray(vehicle.image)) {
    const candidate=typeof item==='string'?item:item?.contentUrl||item?.url;
    try {const url=publicURL(candidate,base).href;if(!images.includes(url))images.push(url);}catch{/* Unsafe/non-HTTP image references are never fetched. */}
    if(images.length===30)break;
  }
  if(!images.length)throw reject('No supported vehicle photos were found. Upload photos instead.','NO_LISTING_PHOTOS');
  return {vehicleName:text(vehicle.name)||'Vehicle listing',vin:text(vehicle.vehicleIdentificationNumber),listingURL:base.href,imageURLs:images};
}

// Conservatively honors matching Disallow rules; an Allow exception does not
// override a denial in this initial importer. Unsupported policy means upload.
export function robotsAllows(body,target) {
  if(body.length>512_000||/<(?:html|!doctype)/i.test(body))return false;
  const groups=[];let group={agents:[],rules:[],started:false};
  for(const raw of body.split(/\r?\n/)) {
    const line=raw.replace(/#.*/,'').trim();const colon=line.indexOf(':');if(colon<0)continue;
    const key=line.slice(0,colon).trim().toLowerCase();const value=line.slice(colon+1).trim();
    if(key==='user-agent') {
      if(group.started){groups.push(group);group={agents:[],rules:[],started:false};}
      group.agents.push(value.toLowerCase());
    }else if(group.agents.length){group.started=true;group.rules.push({key,value});}
  }
  groups.push(group);
  const explicit=groups.filter(g=>g.agents.some(a=>a==='premiereflowimporter'));
  const selected=explicit.length?explicit:groups.filter(g=>g.agents.includes('*'));
  const url=new URL(target);let decoded;
  try{decoded=decodeURIComponent(url.pathname+url.search);}catch{return false;}
  if(selected.reduce((sum,g)=>sum+g.rules.length,0)>256)return false;
  for(const group of selected)for(const {key,value} of group.rules) {
    if(key==='crawl-delay'&&Number(value)>0)return false;
    if(key!=='disallow'||!value)continue;
    if(value.length>2048)return false;
    if(pathMatches(value,url.pathname+url.search)||pathMatches(value,decoded))return false;
  }
  return true;
}

export function imagePreflight(bytes,mime,{minLongEdge=800,minShortEdge=500,maxAspect=3}={}) {
  let width,height,format;
  if(bytes.length<24)return {accepted:false,reason:'This photo is incomplete.'};
  if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND') {
    format='image/png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else if(bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217) {
    format='image/jpeg';let offset=2;
    while(offset+4<bytes.length) {
      if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(offset+2>bytes.length)break;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
      if([0xc0,0xc1,0xc2].includes(marker)&&length>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}
      offset+=length;
    }
  }else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8) {
    format='image/webp';const chunk=bytes.toString('ascii',12,16);
    if(chunk==='VP8X'&&bytes.length>=30&&!(bytes[20]&2)){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(chunk==='VP8L'&&bytes.length>=25&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
    else if(chunk==='VP8 '&&bytes.length>=30&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
  }
  if(!format||mime.split(';')[0].trim().toLowerCase()!==format||!width||!height)return {accepted:false,reason:'This is not a supported JPEG, PNG, or WebP photo.'};
  if(Math.max(width,height)<minLongEdge||Math.min(width,height)<minShortEdge)return {accepted:false,reason:'This photo is too small. Use the original full-size photo.'};
  if(width*height>50_000_000||Math.max(width,height)/Math.min(width,height)>maxAspect)return {accepted:false,reason:'This photo needs manual review. Upload the original vehicle photo.'};
  return {accepted:true,width,height,mime:format,sha256:createHash('sha256').update(bytes).digest('hex')};
}

// Not wired to a public route yet. Authentication/rate limiting, durable review
// ownership, and approved-source persistence must precede enabling this feature.
// No job, credit, upload, or generation is created by inspection.
export function createListingInspector({read=readPublicResource,now=Date.now}={}) {
  return async function inspect(value) {
    const policies=new Map();const expires=now()+90_000;
    const options=maxBytes=>({maxBytes,timeoutMs:Math.min(12_000,Math.max(1,expires-now()))});
    const permitted=async url=>{
      if(now()>=expires)throw reject('The import took too long. Upload photos instead.','LINK_TIMEOUT');
      if(!policies.has(url.origin)){
        const policy=await read(url.origin+'/robots.txt',options(512_000));
        if(policy.status===404||policy.status===410)policies.set(url.origin,'');
        else if(policy.status===200)policies.set(url.origin,policy.body.toString('utf8'));
        else throw reject('This website does not currently permit photo import. Upload photos instead.','SITE_IMPORT_RESTRICTED');
      }
      if(!robotsAllows(policies.get(url.origin),url))throw reject('This website restricts automated access. Upload the photos instead.','SITE_IMPORT_RESTRICTED');
    };
    const url=publicURL(value);await permitted(url);
    const page=await read(url.href,{...options(2_000_000),beforeRequest:permitted});
    if(page.status!==200||!/^text\/html\b|^application\/xhtml\+xml\b/i.test(page.headers['content-type']||''))throw reject('This listing is unavailable or requires a website login. Upload photos instead.','LISTING_UNAVAILABLE');
    const listing=extractVehicleListing(page.body.toString('utf8'),page.url);
    const photos=[],rejected=[];let totalBytes=0;
    for(const sourceURL of listing.imageURLs.slice(0,10)) {
      try {
        const photoURL=publicURL(sourceURL);await permitted(photoURL);
        const response=await read(photoURL.href,{...options(Math.min(12_000_000,50_000_000-totalBytes)),beforeRequest:permitted});
        totalBytes+=response.body.length;
        if(response.status!==200)throw reject('This photo could not be downloaded.');
        const check=imagePreflight(response.body,response.headers['content-type']||'');
        if(!check.accepted){rejected.push({sourceURL,reason:check.reason});continue;}
        if(photos.some(p=>p.sha256===check.sha256))continue;
        photos.push({...check,sourceURL:response.url,bytes:response.body});
      }catch(error){if(!(error instanceof HttpError))throw error;rejected.push({sourceURL,reason:error.message});}
      if(totalBytes>=50_000_000)break;
    }
    if(!photos.length)throw reject('No usable photos could be imported. Upload the original vehicle photos instead.','NO_USABLE_LISTING_PHOTOS');
    return {status:'REVIEW_REQUIRED',vehicleName:listing.vehicleName,vin:listing.vin,listingURL:listing.listingURL,photos,rejected,
      remainingCandidateCount:Math.max(0,listing.imageURLs.length-10),
      checks:{dimensions:'checked',duplicateBytes:'removed',visualQuality:'pending_existing_engine_gate',sameVehicle:'pending_existing_engine_gate'},
      customerApprovalRequired:true,jobCreated:false,creditConsumed:false};
  };
}
