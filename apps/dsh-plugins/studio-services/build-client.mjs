import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const begin='    // BEGIN GENERATED JAPANESE DICTIONARY\n',end='    // END GENERATED JAPANESE DICTIONARY';
// Only this bounded generated region changes. The service implementation stays
// readable and the browser needs no dictionary request or generic language pack.
export function clientSource(source,dictionary){
  if(!dictionary||typeof dictionary!=='object'||Array.isArray(dictionary)||Object.values(dictionary).some(value=>typeof value!=='string'))throw Error('Service translations must be a string dictionary.');
  const first=source.indexOf(begin),last=source.indexOf(end);
  if(first<0||last<=first||source.indexOf(begin,first+1)>=0||source.indexOf(end,last+1)>=0)throw Error('Service dictionary markers are missing or duplicated.');
  return source.slice(0,first+begin.length)+'    const ja='+JSON.stringify(dictionary,null,2).replaceAll('\n','\n    ')+';\n'+source.slice(last);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const source=await readFile(new URL('./client.js',import.meta.url),'utf8'),dictionary=JSON.parse(await readFile(new URL('./ja.json',import.meta.url),'utf8'));
  await writeFile(new URL('./client.js',import.meta.url),clientSource(source,dictionary),'utf8');
  console.log(JSON.stringify({namespace:'studio.services',strings:Object.keys(dictionary).length}));
}
