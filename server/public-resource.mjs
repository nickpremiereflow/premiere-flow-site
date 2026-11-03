import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {HttpError} from './http.mjs';

const blocked=new BlockList();
for (const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(network,prefix,'ipv4');
blocked.addAddress('168.63.129.16','ipv4'); // Azure platform virtual address.
export const publicIPv4=value=>isIP(value)===4&&!blocked.check(value,'ipv4');
const fail=(message='This link cannot be imported. Upload the vehicle photos instead.',code='LINK_UNAVAILABLE')=>new HttpError(422,message,code);

export function publicURL(value,base) {
  if (typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value)||/%(?:2f|5c|2e)/i.test(value.split(/[?#]/)[0])) throw fail();
  let url;try {url=new URL(value,base);} catch {throw fail();}
  // Domain names only; alternate numeric-IP spellings normalize to IPs here.
  if (url.protocol!=='https:'||url.username||url.password||url.port||isIP(url.hostname)||url.hostname.includes(':')||!url.hostname.includes('.')||url.hostname.endsWith('.')||/\.(?:localhost|local|internal|test|invalid|example)$/i.test(url.hostname)||/%(?:2f|5c|2e)/i.test(url.pathname)) throw fail();
  url.hash='';return url;
}

function deadline(promise,ms) {
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('The listing site took too long to respond. Upload photos instead.','LINK_TIMEOUT')),ms);})]).finally(()=>clearTimeout(timer));
}

// The selected DNS result is pinned to the socket. No second resolution, proxy,
// cookies, credentials, browser execution, or private-network fallback is used.
export function createPublicReader({resolve=lookup,send=request,now=Date.now}={}) {
  return async function read(value,{maxBytes=2_000_000,timeoutMs=12_000,beforeRequest=async()=>{}}={}) {
    let url=publicURL(value);const expires=now()+timeoutMs;
    for(let hop=0;hop<=3;hop++) {
      const remaining=()=>Math.max(0,expires-now());
      if(!remaining()) throw fail('The listing site took too long to respond. Upload photos instead.','LINK_TIMEOUT');
      await deadline(Promise.resolve(beforeRequest(url)),remaining());
      const addresses=await deadline(resolve(url.hostname,{all:true,family:4}),remaining());
      if(!Array.isArray(addresses)||!addresses.length||addresses.some(a=>a.family!==4||!publicIPv4(a.address))) throw fail('This link is not a public listing website.','LINK_DESTINATION_BLOCKED');
      const address=addresses[0].address;
      const result=await new Promise((resolveResult,reject)=>{
        let req,timer,done=false;
        const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolveResult(value);};
        req=send(url,{
          method:'GET',agent:false,maxHeaderSize:16_384,
          headers:{'user-agent':'PremiereFlowImporter/1.0 (+https://www.premiereflow.com)','accept':'text/html,application/xhtml+xml,image/jpeg,image/png,image/webp,text/plain;q=0.8','accept-encoding':'identity'},
          lookup:(_host,options,callback)=>options?.all?callback(null,[{address,family:4}]):callback(null,address,4)
        },res=>{
          const status=res.statusCode||0;const headers=res.headers;
          if([301,302,303,307,308].includes(status)) {res.destroy();finish(null,{status,headers,body:Buffer.alloc(0)});return;}
          if(Number(headers['content-length'])>maxBytes||headers['content-encoding']&&!['identity'].includes(headers['content-encoding'].toLowerCase())) {
            finish(fail('This file is too large or uses an unsupported transfer format. Upload photos instead.','LINK_RESPONSE_TOO_LARGE'));res.destroy();return;
          }
          let bytes=0;const chunks=[];
          res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){finish(fail('This file is too large to import. Upload photos instead.','LINK_RESPONSE_TOO_LARGE'));res.destroy();}else chunks.push(chunk);});
          res.on('end',()=>finish(null,{status,headers,body:Buffer.concat(chunks)}));
          res.on('error',()=>finish(fail()));res.on('aborted',()=>finish(fail()));
        });
        req.on('error',()=>finish(fail()));
        timer=setTimeout(()=>{finish(fail('The listing site took too long to respond. Upload photos instead.','LINK_TIMEOUT'));req.destroy();},remaining());
        req.end();
      });
      if([301,302,303,307,308].includes(result.status)) {
        if(hop===3||typeof result.headers.location!=='string') throw fail();
        url=publicURL(result.headers.location,url);continue;
      }
      return {...result,url:url.href};
    }
    throw fail();
  };
}
export const readPublicResource=createPublicReader();
