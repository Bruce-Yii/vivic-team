import {createHash} from "node:crypto";
import {z} from "zod";
import {definitionKey,definitionRef,canonicalJson} from "@vivic/card-runtime";
import type {HostedSpaceStore,SpaceIdentity} from "../space/store.js";
import {SpaceError} from "../space/errors.js";
import {hostedBody,hostedJson} from "../hosted/http.js";
import {OwnerCanvasSchema} from "../hosted/owner.js";
import {assertCardPackageOrigin,hostedDefinitionRows,mergeHostedDefinitions} from "../hosted/cardPackages.js";
import {QuantProfileSchema,buildQuantCards,fetchPandaMarket} from "./cards.js";
const ImportSchema=z.strictObject({requestId:z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),profile:QuantProfileSchema,symbol:z.enum(["000300.SH","600519.SH","601088.SH"]).default("000300.SH")});
export async function quantThroneRoute(store:HostedSpaceStore,request:Request,identity:SpaceIdentity,fetchImpl:typeof fetch=fetch):Promise<Response|null>{
 const route=new URL(request.url).pathname;if(!route.startsWith("/api/quant-throne/"))return null;
 assertCardPackageOrigin(request);store.assertDeviceActive(identity.accountId,identity.device.id);
 if(route==="/api/quant-throne/claim"&&request.method==="POST"){
  const value=z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{32}$/)}).parse(await hostedBody(request,2048));
  const response=await fetchImpl("https://edsionc.top/quant-throne/api/transfer/claim",{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new SpaceError(response.status===410?410:503,"transfer-unavailable","画像传送已过期或暂不可用，请从量权重新发送。");
  const body=await response.json()as{profile?:unknown};return hostedJson({ok:true,profile:QuantProfileSchema.parse(body.profile)});
 }
 if(route==="/api/quant-throne/market"&&request.method==="GET"){
  const query=new URL(request.url).searchParams;if([...query.keys()].some(k=>k!=="symbol"))throw new SpaceError(400,"invalid-query","仅支持symbol查询参数。");
  return hostedJson(await fetchPandaMarket(query.get("symbol")||"000300.SH",fetchImpl));
 }
 if(route!=="/api/quant-throne/import"||request.method!=="POST")throw new SpaceError(404,"not-found","没有此量权接口。");
 const input=ImportSchema.parse(await hostedBody(request,96*1024));
 const spaceId="quant-"+createHash("sha256").update(identity.accountId+":"+input.requestId).digest("hex").slice(0,24);
 const receiptKey="quantThroneReceipt:"+spaceId;
 const fingerprint=createHash("sha256").update(canonicalJson(input)).digest("hex");
 const prior=store.listSpaces(identity.accountId).find(s=>s.id===spaceId);
 if(prior){if(store.getAccountValue<{fingerprint:string}>(identity.accountId,receiptKey)?.fingerprint!==fingerprint)throw new SpaceError(409,"request-id-conflict","同一请求编号已用于不同的量权结果。");return hostedJson({ok:true,spaceId,cards:store.getSnapshot(identity.accountId,spaceId).space.cards.length,deduplicated:true});}
 let market=null;try{market=await fetchPandaMarket(input.symbol,fetchImpl);}catch{/* The market card explicitly renders unavailable, never fabricated prices. */}
 const {definitions,cards}=await buildQuantCards(input.profile,market,input.requestId);
 request.signal.throwIfAborted();
 store.transaction(()=>{
  store.assertDeviceActive(identity.accountId,identity.device.id);
  const rows=definitions.map(definition=>({key:definitionKey(definitionRef(definition)),definition,enabled:true}));
  const merged=mergeHostedDefinitions(hostedDefinitionRows(store,identity.accountId),rows);
  store.setAccountValue(identity.accountId,"hostedDefinitions",merged);
  const record=OwnerCanvasSchema.parse({schemaVersion:1,id:spaceId,title:`量权 · ${input.profile.persona.name}`,version:1,updatedAt:new Date().toISOString(),cardsById:Object.fromEntries(cards.map(c=>[c.id,c])),cardOrder:cards.map(c=>c.id),viewport:{x:0,y:0,zoom:1},focusHistory:[],processedRequestIds:[input.requestId]});
  store.saveOwnerCanvas(identity.accountId,{record,expectedVersion:null,requestId:input.requestId},identity.device.id);
  store.setAccountValue(identity.accountId,receiptKey,{fingerprint,spaceId});
  store.setAccountValue(identity.accountId,"ownerUI:lastCanvasId",spaceId);
 });
 return hostedJson({ok:true,spaceId,cards:cards.length,marketStatus:market?"real-data":"unavailable",packageIds:definitions.map(d=>d.manifest.id),message:"已创建独立量权Space，三张卡片已保存。"},200,{"X-Vivic-Space":spaceId,"X-Vivic-Space-Version":"1"});
}
