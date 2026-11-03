import {cp,mkdir,rm,stat} from 'node:fs/promises';
import {resolve} from 'node:path';

// Only these public files can be served. Backend files and secrets stay private.
const publicFiles=['index.html','header.js','portal.js','script.js','style.css','about','terms','sign-up','confirmation','login','setup','dashboard','logo.png','premiereflowfavicon.png','premiereflowiconlogo.png','exterior-before.png','exterior-after.png','interior-before.png','interior-after.png'];
const target=resolve('public');
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
for(const file of publicFiles){await stat(file);await cp(file,resolve(target,file),{recursive:true});}
console.log('Public site built. Server code and secrets excluded.');
