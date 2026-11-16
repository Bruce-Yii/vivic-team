import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {zipSync} from "fflate";
import {readPackageZip,canonicalJson} from "@vivic/card-runtime";
import {quantDefinitions} from "./definitions.js";
const root=path.resolve(process.argv[2]||"delivery/quant-throne");await mkdir(root,{recursive:true});
for(const definition of await quantDefinitions()){
 const folder=path.join(root,definition.manifest.id);await mkdir(folder,{recursive:true});
 for(const [name,value]of Object.entries(definition.files)){await mkdir(path.dirname(path.join(folder,name)),{recursive:true});await writeFile(path.join(folder,name),JSON.stringify(value,null,2)+"\n");}
 const zip=zipSync(Object.fromEntries(Object.entries(definition.files).map(([name,value])=>[name,new TextEncoder().encode(canonicalJson(value))])),{level:6});
 const restored=await readPackageZip(zip);if(restored.hash!==definition.hash)throw new Error("Card package identity changed during ZIP roundtrip");
 await writeFile(path.join(root,definition.manifest.id+".vivicard"),zip);console.log(definition.manifest.id+" "+definition.hash);
}
