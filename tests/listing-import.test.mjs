import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {createPublicReader,publicURL,publicIPv4} from '../server/public-resource.mjs';
import {extractVehicleListing,robotsAllows,imagePreflight,createListingInspector} from '../server/listing-import.mjs';

const listingURL='https://dealer.example.com/inventory/mustang';
const photoURL='https://photos.example.com/vehicle.png';
const html=vehicle=>'<html><script type="application/ld+json">'+JSON.stringify(vehicle)+'</script></html>';
const car={'@type':'Car',name:'Ford Mustang GT',vehicleIdentificationNumber:'CONTROLLED-VIN',image:[photoURL]};
const png=await readFile(new URL('../exterior-before.png',import.meta.url));

test('link imports reject credentials, private destinations, alternate IP notation and non-HTTPS URLs',()=>{
  for(const url of ['http://dealer.example.com/a','https://127.1/a','https://2130706433/a','https://0x7f000001/a','https://[::1]/a','https://a:b@dealer.example.com/a','https://dealer.example.com:8443/a','file:///etc/passwd','https://localhost/a','https://host.internal/a','https://dealer.example.com/%2e%2e/private','https://dealer.example.com/with space'])assert.throws(()=>publicURL(url),{status:422});
  for(const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','224.1.1.1','255.255.255.255','168.63.129.16','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
  assert.equal(publicURL('/inventory/1#gallery',listingURL).href,'https://dealer.example.com/inventory/1');
});

function networkFixture(replies,{addresses=[{address:'8.8.8.8',family:4}]}={}) {
  const requests=[];let lookups=0;
  const read=createPublicReader({resolve:async()=>{lookups++;return addresses;},send:(url,options,callback)=>{
    const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{
      const reply=replies[requests.length];requests.push({url:url.href,options});
      const res=Readable.from(reply.chunks||[Buffer.from(reply.body||'')]);res.statusCode=reply.status||200;res.headers=reply.headers||{};callback(res);
    });return req;
  }});return {read,requests,get lookups(){return lookups;}};
}

test('DNS results are validated and pinned while TLS hostname and credential-free headers remain intact',async()=>{
  const f=networkFixture([{body:'ok'}]);await f.read(listingURL);
  const {url,options}=f.requests[0];assert.equal(url,listingURL);assert.equal(options.agent,false);
  assert.equal(options.headers.authorization,undefined);assert.equal(options.headers.cookie,undefined);
  options.lookup('dealer.example.com',{},(error,ip,family)=>{assert.equal(error,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
  options.lookup('dealer.example.com',{all:true},(error,results)=>{assert.deepEqual(results,[{address:'8.8.8.8',family:4}]);});
  assert.equal(f.lookups,1);
  const bad=networkFixture([],{addresses:[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]});
  await assert.rejects(bad.read(listingURL),{code:'LINK_DESTINATION_BLOCKED'});assert.equal(bad.requests.length,0);
});

test('redirects revalidate destination and stop before private-network access',async()=>{
  const f=networkFixture([{status:302,headers:{location:'https://127.0.0.1/secrets'}}]);
  await assert.rejects(f.read(listingURL),{status:422});assert.equal(f.requests.length,1);
  const allowed=networkFixture([{status:302,headers:{location:'/stock/one'}},{body:'one'}]);const checked=[];
  const r=await allowed.read(listingURL,{beforeRequest:async url=>checked.push(url.href)});
  assert.deepEqual(checked,[listingURL,'https://dealer.example.com/stock/one']);assert.equal(r.body.toString(),'one');assert.equal(allowed.lookups,2);
  const loop=networkFixture(Array.from({length:4},()=>({status:302,headers:{location:'/again'}})));
  await assert.rejects(loop.read(listingURL));assert.equal(loop.requests.length,4);
});

test('oversized, compressed, and streaming-over-limit responses are rejected',async()=>{
  for(const reply of [{headers:{'content-length':'100'}},{headers:{'content-encoding':'gzip'}},{chunks:[Buffer.alloc(6),Buffer.alloc(6)]}]) {
    const f=networkFixture([reply]);await assert.rejects(f.read(listingURL,{maxBytes:10}),{code:'LINK_RESPONSE_TOO_LARGE'});
  }
});

test('extract only one vehicle, deduplicate its URLs and ignore unrelated page images',()=>{
  const parsed=extractVehicleListing('<img src="https://photos.example.com/logo.png">'+html({'@graph':[car,{...car}]}),listingURL);
  assert.equal(parsed.vehicleName,'Ford Mustang GT');assert.deepEqual(parsed.imageURLs,[photoURL]);
  assert.throws(()=>extractVehicleListing(html([car,{...car,vehicleIdentificationNumber:'SECOND-CAR'}]),listingURL),{code:'LISTING_NOT_SINGLE_VEHICLE'});
  assert.throws(()=>extractVehicleListing('<script>window.car="fake"</script><img src="car.jpg">',listingURL),{code:'LISTING_NOT_SINGLE_VEHICLE'});
  assert.throws(()=>extractVehicleListing(html({...car,image:['http://photos.example.com/car.jpg','https://127.0.0.1/secret']}),listingURL),{code:'NO_LISTING_PHOTOS'});
});

test('robots restrictions, bot-specific rules, wildcard paths and inaccessible policies fail closed',()=>{
  assert.equal(robotsAllows('User-agent: *\nDisallow: /inventory',listingURL),false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*mustang$',listingURL),false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /admin',listingURL),true);
  assert.equal(robotsAllows('User-agent: PremiereFlowImporter\nDisallow: /\nUser-agent: *\nAllow: /',listingURL),false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /inventory\nAllow: /inventory/mustang',listingURL),false);
  assert.equal(robotsAllows('User-agent: *\nCrawl-delay: 10',listingURL),false);
  assert.equal(robotsAllows('<!DOCTYPE html><html>Login</html>',listingURL),false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /secret',new URL('/%73ecret',listingURL)),false);
});

test('photo preflight checks actual repository image dimensions, MIME, thumbnails and malformed files',()=>{
  const check=imagePreflight(png,'image/png');assert.equal(check.accepted,true);assert.ok(check.width>=800);assert.equal(check.sha256.length,64);
  assert.equal(imagePreflight(png,'text/html').accepted,false);
  assert.equal(imagePreflight(png.subarray(0,24),'image/png').accepted,false);
  const small=Buffer.from(png);small.writeUInt32BE(150,16);small.writeUInt32BE(150,20);assert.equal(imagePreflight(small,'image/png').accepted,false);
  assert.equal(imagePreflight(Buffer.from('<svg><script>bad()</script></svg>'),'image/svg+xml').accepted,false);
});

test('inspection downloads real photo bytes, removes duplicates, explains rejection, and never creates jobs or charges',async()=>{
  const calls=[];
  const read=async(url,options)=>{
    calls.push(url);if(options.beforeRequest)await options.beforeRequest(new URL(url));
    if(url.endsWith('/robots.txt'))return {status:404,body:Buffer.alloc(0),headers:{},url};
    if(url===listingURL)return {status:200,body:Buffer.from(html({...car,image:[photoURL,photoURL+'?copy=1','https://photos.example.com/bad.png']})),headers:{'content-type':'text/html'},url};
    return {status:200,body:url.includes('bad.png')?Buffer.from('not an image'):png,headers:{'content-type':'image/png'},url};
  };
  const result=await createListingInspector({read})(listingURL);
  assert.equal(result.status,'REVIEW_REQUIRED');assert.equal(result.photos.length,1);assert.equal(result.rejected.length,1);
  assert.deepEqual(result.photos[0].bytes,png);assert.equal(result.customerApprovalRequired,true);assert.equal(result.jobCreated,false);assert.equal(result.creditConsumed,false);
  assert.equal(result.checks.visualQuality,'pending_existing_engine_gate');assert.equal(calls.filter(u=>u.endsWith('/robots.txt')).length,2);
});

test('robots denial prevents downloading listing or image content',async()=>{
  const calls=[];const read=async url=>{calls.push(url);return {url,status:200,body:Buffer.from('User-agent: *\nDisallow: /'),headers:{'content-type':'text/plain'}};};
  await assert.rejects(createListingInspector({read})(listingURL),{code:'SITE_IMPORT_RESTRICTED'});
  assert.deepEqual(calls,['https://dealer.example.com/robots.txt']);
});

test('unavailable robots policy, unsupported listing, and no usable images provide upload fallback without a job',async()=>{
  for(const status of [401,403,429,500])await assert.rejects(createListingInspector({read:async()=>({status,body:Buffer.alloc(0)})})(listingURL),{code:'SITE_IMPORT_RESTRICTED'});
  const read=async url=>url.endsWith('/robots.txt')?{url,status:404,body:Buffer.alloc(0)}:url===listingURL?{url,status:200,headers:{'content-type':'text/html'},body:Buffer.from(html(car))}:{url,status:403,headers:{},body:Buffer.alloc(0)};
  await assert.rejects(createListingInspector({read})(listingURL),{code:'NO_USABLE_LISTING_PHOTOS'});
});
