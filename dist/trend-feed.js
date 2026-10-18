import {marketClock} from './market.js';

export const TREND_FEED_URL='https://blackrimmedlol-code.github.io/us-market-dashboard/trading-trends.json';
const symbols=['SOXL','GDXU','BITX'];
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function currentAutoHour(at,now=new Date().toISOString()){
  if(!stamp(at)||!stamp(now))return false;
  const c=marketClock(now),bar=marketClock(at),age=Date.parse(now)-Date.parse(at),latest=570+Math.floor((c.minute-570)/60)*60;
  return !!c.regular&&bar.day===c.day&&bar.minute===latest&&age>=0&&age<=90*60000;
}
export function validateTrendFeed(feed,now=null){
  if(!feed||feed.schemaVersion!==1||feed.rulesVersion!=='gnot-trend-1h-v1'||feed.timeframe!=='1h'||feed.regularOnly!==true||!stamp(feed.generatedAt)||!feed.assets||Object.keys(feed.assets).length!==3||!symbols.every(s=>Object.hasOwn(feed.assets,s)))throw Error('自动趋势快照格式不匹配');
  if(now&&Date.parse(feed.generatedAt)>Date.parse(now)+60000)throw Error('自动趋势快照时间在未来');
  for(const symbol of symbols){
    const row=feed.assets[symbol],keys=['close1h','ema20','ema50','atr14'];
    if(!row||row.symbol!==symbol||!['verified','unavailable'].includes(row.status))throw Error('自动趋势标的或状态不匹配');
    if(row.status==='unavailable'){
      if(keys.some(k=>row[k]!==null)||row.barCloseAt!==null||row.trend!=='unknown')throw Error('缺失趋势数据不能冒充有效数字');
      continue;
    }
    const c=marketClock(row.barCloseAt),start=marketClock(row.barStartAt),duration=Date.parse(row.barCloseAt)-Date.parse(row.barStartAt);
    if(!keys.every(k=>positive(row[k]))||!Number.isInteger(row.barCount)||row.barCount<250||!stamp(row.barCloseAt)||!stamp(row.barStartAt)||!c.open||c.day!==row.marketDate||start.day!==c.day||start.minute<570||(start.minute-570)%60!==0||c.minute!==Math.min(start.minute+60,c.close)||duration<=0||duration>3600000||Date.parse(row.barCloseAt)>Date.parse(feed.generatedAt)||!/^https:\/\/query[12]\.finance\.yahoo\.com\//.test(row.sourceUrl??''))throw Error('自动趋势数值、来源或已收盘K线时间无效');
    const trend=row.close1h>row.ema50&&row.ema20>row.ema50?'qualified':'not-qualified';
    if(row.trend!==trend)throw Error('自动趋势标签与计算值不一致');
  }
  return structuredClone(feed);
}
export function trendMode(state,symbol){
  const w=state.workbench??{},raw=w.inputs?.[symbol]??{};
  return w.trendModes?.[symbol]??(['close1h','ema20','ema50'].every(k=>Number(raw[k])>0)?'manual':'auto');
}
export function trendSnapshot(state,symbol,now=new Date().toISOString()){
  const mode=trendMode(state,symbol),w=state.workbench??{};
  if(mode==='manual')return {mode,status:'manual',row:null,label:'手动核对 · 使用本机填写值'};
  const feed=w.trendFeed;
  try{validateTrendFeed(feed,now);}catch(error){return {mode,status:'unavailable',row:null,label:feed?error.message:'尚未取得自动趋势快照'};}
  const row=feed.assets[symbol];
  if(row.status!=='verified')return {mode,status:'unavailable',row:null,label:row.note||'本轮来源未取得有效小时数据',generatedAt:feed.generatedAt};
  const c=marketClock(now),fresh=currentAutoHour(row.barCloseAt,now);
  return {mode,status:!c.regular?'reference':fresh?'fresh':'stale',row,fresh:!!fresh&&c.regular,generatedAt:feed.generatedAt,label:!c.regular?'休市参考 · 不放行新开':fresh?'已收盘小时快照有效':'小时快照已过期 · 更新或手动核对'};
}
export function effectiveMarketInput(state,symbol,now=new Date().toISOString()){
  const raw=state.workbench?.inputs?.[symbol]??{},snapshot=trendSnapshot(state,symbol,now);
  if(snapshot.mode==='manual')return {...raw,trendOrigin:'manual'};
  if(!snapshot.row)return {...raw,close1h:'',ema20:'',ema50:'',hourAt:'',trendOrigin:'auto-unavailable'};
  const r=snapshot.row;
  return {...raw,atr:r.atr14,close1h:r.close1h,ema20:r.ema20,ema50:r.ema50,hourAt:r.barCloseAt,trendOrigin:'auto',autoTrendFresh:snapshot.fresh,trendSourceUrl:r.sourceUrl,trendGeneratedAt:snapshot.generatedAt};
}
export function acceptTrendFeed(state,feed,now=new Date().toISOString()){
  const next=validateTrendFeed(feed,now),w=state.workbench;
  if(!w)throw Error('工作台尚未初始化');
  if(w.trendFeed&&Date.parse(next.generatedAt)<Date.parse(w.trendFeed.generatedAt))throw Error('收到较旧的趋势快照，保留当前版本');
  if(JSON.stringify(w.trendFeed)===JSON.stringify(next))return false;
  w.trendFeed=next;return true;
}
