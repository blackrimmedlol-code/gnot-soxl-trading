import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(root,'dist');
const output=path.join(root,'.pages');
const assets=['core.js','storage.js','app.js','discipline.js','workbench-ui.js','risk.js','risk-ui.js','market.js','TRADING_RULES.md','style.css','icon.svg'];
const digest=createHash('sha256');
for(const name of assets) digest.update(name).update(await readFile(path.join(source,name)));
const version=digest.digest('hex').slice(0,12);
await mkdir(output,{recursive:true});
await cp(source,output,{recursive:true});
for(const name of ['index.html','app.js','storage.js','discipline.js','workbench-ui.js','risk.js','risk-ui.js','market.js']){
  const file=path.join(output,name);
  const text=await readFile(file,'utf8');
  const stamped=text.replace(/(['"])\.\/(core\.js|storage\.js|app\.js|discipline\.js|workbench-ui\.js|risk\.js|risk-ui\.js|market\.js|TRADING_RULES\.md|style\.css|icon\.svg)(?:\?v=[a-z0-9-]+)?\1/g,
    (_match,quote,asset)=>`${quote}./${asset}?v=${version}${quote}`);
  await writeFile(file,stamped);
}
// The layout harness must load the same build, even when index.html is cached.
const harness=path.join(output,'qa-layout.html');
const harnessText=await readFile(harness,'utf8');
await writeFile(harness,harnessText.replace(/(src|href)="\.\/index\.html(#[^"]*)?"/g,
  (_match,attribute,hash='')=>`${attribute}="./index.html?v=${version}${hash}"`));
console.log(`Pages assets: ${version}`);
