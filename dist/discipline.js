// 2026-10-18 strategy. Pure calculations; never retrieves prices or routes orders.
import {accounting, positionRisk, newRound, uid, usDay, validateState} from './core.js';

export const WATCHLIST=['SOXL','GDXU','BITX'];
export const DISCIPLINE=Object.freeze({asOf:'2026-10-18',initialEquity:30000,riskPct:.005,totalRiskPct:.015,singlePct:.25,maxPct:.60});
const EPS=1e-8, num=v=>v===''||v==null?NaN:Number(v), pos=v=>Number.isFinite(num(v))&&num(v)>0;
const rounded=v=>Number(v.toFixed(8));
// NYSE published calendar, 2026–2028. Unknown years fail closed.
const CLOSED=new Set(('2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 '+
  '2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 '+
  '2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25').split(' '));
const HALF=new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
export function marketDay(day){const year=Number(day.slice(0,4)),dow=new Date(day+'T12:00:00Z').getUTCDay();return year>=2026&&year<=2028&&dow>0&&dow<6&&!CLOSED.has(day);}
const plusDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
export function nextTradingDay(day,{full=false}={}){for(let i=0;i<370;i++){day=plusDay(day);if(marketDay(day)&&(!full||!HALF.has(day)))return day;}return null;}
export function marketClock(at=new Date().toISOString()){
  const d=new Date(at);if(!Number.isFinite(d.getTime()))return {valid:false};
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
  const day=`${p.year}-${p.month}-${p.day}`,minute=Number(p.hour)*60+Number(p.minute),open=marketDay(day),half=HALF.has(day);
  const close=half?780:960, tomorrow=plusDay(day),beforeBreak=open&&!marketDay(tomorrow);
  return {valid:true,day,minute,half,open,close,regular:open&&minute>=570&&minute<close,entry:open&&!half&&minute>=630&&minute<930,beforeBreak,exitDue:beforeBreak&&minute>=close-5&&minute<close};
}
export function ensureWorkbench(state){
  state.workbench??={version:1,equity:30000,cash:state.rounds.some(r=>r.fills.length)?'':30000,inputs:{},recoveries:[],activatedAt:new Date().toISOString()};
  state.workbench.recoveries??=[];return state.workbench;
}
export function priceLevels(input){
  const entry=num(input.entry),atr=num(input.atr),low=num(input.low);
  if(!pos(entry)||!pos(atr)||!pos(low))return {valid:false,errors:['填写买入参考价、1小时 ATR(14)、含信号K线的近6根30分钟最低价。']};
  if(low>entry)return {valid:false,errors:['结构低点高于买入参考价，请核对同一标的和数据时段。']};
  const structure=rounded(low-.1*atr),volatility=rounded(entry-1.5*atr),stop=rounded(Math.min(structure,volatility)),distance=rounded(entry-stop);
  if(stop<=0||distance<=0)return {valid:false,errors:['当前参数无法形成有效正价止损，放弃本笔。']};
  const target=rounded(entry+2*distance),tooWide=distance>3*atr+EPS;
  return {valid:true,entry,atr,low,structure,volatility,stop,distance,target,stopPct:distance/entry,targetPct:2*distance/entry,tooWide,atrMultiple:distance/atr,errors:[],rule:structure<volatility?'结构低点决定止损':'1.5倍小时ATR决定止损'};
}
const stampOk=(v,now)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=Date.parse(now);
export function trendState(input={},now=new Date().toISOString()){
  if(!['close1h','ema20','ema50'].every(k=>pos(input[k])))return {known:false,pass:false,reason:'待填小时趋势数据'};
  if(!stampOk(input.hourAt,now))return {known:false,pass:false,reason:'小时K线收盘时间未确认或在未来'};
  const t=marketClock(input.hourAt),n=marketClock(now),age=Date.parse(now)-Date.parse(input.hourAt);
  if(!t.open||t.minute<630||t.minute>960||t.minute%30!==0)return {known:false,pass:false,reason:'请填写正常时段已收盘小时K线时间'};
  if(t.day!==n.day||age>90*60000)return {known:false,pass:false,reason:'小时数据已过期，更新后再核对'};
  const pass=num(input.close1h)>num(input.ema50)&&num(input.ema20)>num(input.ema50);
  return {known:true,pass,reason:pass?'小时趋势合格':'小时趋势不合格'};
}
export function entrySignal(input={},now=new Date().toISOString()){
  const trend=trendState(input,now),clock=marketClock(now);
  const complete=pos(input.high)&&pos(input.close30),breakout=complete?num(input.close30)>num(input.high):null;
  const signalClock=stampOk(input.signalAt,now)?marketClock(input.signalAt):null;
  const age=Date.parse(now)-Date.parse(input.signalAt),signalTime=!!signalClock&&signalClock.open&&!signalClock.half&&signalClock.minute>=630&&signalClock.minute<=900&&signalClock.minute%30===0;
  const fresh=signalTime&&signalClock.day===clock.day&&age>=0&&age<30*60000;
  const reasons=[];
  if(!trend.known||!trend.pass)reasons.push(trend.reason);
  if(breakout===null)reasons.push('待核对30分钟突破');else if(!breakout)reasons.push('30分钟收盘尚未突破前6根最高价');
  if(!signalTime)reasons.push('信号须为10:30–15:00 ET的已收盘30分钟K线');else if(!fresh)reasons.push('30分钟信号已过期，等待新信号');
  if(!clock.entry)reasons.push('当前不在规则开仓窗口');
  if(stampOk(input.hourAt,now)&&signalTime&&Date.parse(input.hourAt)>Date.parse(input.signalAt))reasons.push('小时数据晚于买入信号，不能使用后来的数据确认过去买点');
  return {pass:reasons.length===0,trend,breakout,fresh,signalTime,clock,reasons};
}
export function disciplineGuard(state,now=new Date().toISOString()){
  const events=[],effective=Date.parse(state.workbench?.activatedAt??'2026-10-18T00:00:00+08:00');
  for(const r of state.rounds.filter(r=>r.scope==='active')){
    const a=accounting({...r,fills:r.fills.filter(f=>Date.parse(f.at)<=Date.parse(now))});
    if(a.closed&&Date.parse(a.exitAt)>=effective)events.push({at:a.exitAt,kind:a.realized<-EPS?'loss':a.realized>EPS?'win':'flat'});
    if(r.executionModel?.mode==='atr-2r')for(const f of r.fills)if(f.violations.length&&Date.parse(f.at)>=effective&&Date.parse(f.at)<=Date.parse(now))events.push({at:f.at,kind:'breach'});
  }
  events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||({win:0,flat:1,loss:2,breach:3}[a.kind]-{win:0,flat:1,loss:2,breach:3}[b.kind]));
  let streak=0,trigger=null,resumeDay=null;
  const reviews=state.workbench?.recoveries??[];
  const reviewed=(after,before)=>reviews.some(r=>Date.parse(r.at)>=Date.parse(after)&&Date.parse(r.at)<=Date.parse(before)&&r.notes.trim().length>=10);
  for(const event of events){
    if(trigger&&resumeDay&&usDay(event.at)>=resumeDay&&reviewed(trigger.at,event.at)){trigger=null;streak=0;resumeDay=null;}
    if(event.kind==='breach') {trigger=event;streak=0;}
    else if(!trigger){if(event.kind==='win')streak=0;else if(event.kind==='loss'&&++streak>=2)trigger=event;}
    if(trigger===event) {const full=nextTradingDay(usDay(event.at),{full:true});resumeDay=full?nextTradingDay(full):null;}
  }
  const rested=!trigger||(resumeDay!==null&&usDay(now)>=resumeDay),hasReview=!trigger||reviewed(trigger.at,now);
  const blocked=!!trigger&&(!rested||!hasReview);
  const reasons=blocked?[!rested?`暂停新开仓；最早 ${resumeDay??'待更新交易日历'} 美东日期恢复。`:'休息期已满，填写恢复复盘后再开仓。']:[];
  if(trigger&&rested&&hasReview)streak=0;
  return {blocked,reasons,streak,trigger,resumeDay,rested,reviewed:hasReview};
}
export function disciplinePortfolio(state,now=new Date().toISOString(),excludeId=null){
  let risk=0,value=0;const unknown=[],positions=[];
  for(const r of state.rounds){
    if(r.id===excludeId)continue;
    const view={...r,fills:r.fills.filter(f=>Date.parse(f.at)<=Date.parse(now))},a=accounting(view);
    if(!a.qty)continue;
    const manual=state.workbench?.inputs?.[r.symbol],mark=r.mark&&Date.parse(r.mark.at)<=Date.parse(now)&&Date.parse(now)-Date.parse(r.mark.at)<5*60000?r.mark:null;
    const inputMark=manual&&pos(manual.current)&&stampOk(manual.currentAt,now)&&Date.parse(now)-Date.parse(manual.currentAt)<5*60000?num(manual.current):null;
    const last=inputMark??mark?.price;
    if(!pos(last))unknown.push(`${r.symbol} 最新估值`);else value+=a.qty*last;
    let reserved;
    if(r.scope==='active'){
      reserved=r.executionModel?.mode==='atr-2r'?r.initialRisk:positionRisk(view).risk;
      if(!Number.isFinite(reserved))unknown.push(`${r.symbol} 风险`);else risk+=reserved;
    }else{
      // History-class holdings still consume capital; unknown risk cannot be hidden by classification.
      reserved=positionRisk(view).remainingRisk;
      if(!Number.isFinite(reserved))unknown.push(`${r.symbol} 止损风险`);else risk+=reserved;
    }
    positions.push({id:r.id,symbol:r.symbol,qty:a.qty,value:pos(last)?a.qty*last:null,risk:reserved});
  }
  return {risk,value,unknown:[...new Set(unknown)],valid:unknown.length===0,positions};
}
export function calculateWorkbench(state,symbol,input=state.workbench?.inputs?.[symbol]??{},now=new Date().toISOString(),excludeId=null){
  const w=state.workbench??{equity:30000,cash:'',inputs:{}},equity=num(w.equity),cash=num(w.cash),levels=priceLevels(input),signal=entrySignal(input,now),guard=disciplineGuard(state,now),portfolio=disciplinePortfolio(state,now,excludeId);
  const trends=WATCHLIST.map(s=>({symbol:s,...trendState(s===symbol?input:w.inputs[s],now)})),qualified=trends.filter(x=>x.known&&x.pass).length,unknown=trends.filter(x=>!x.known).length;
  const cap=[0,.25,.5,.6][qualified],singleBudget=equity*.005,totalBudget=equity*.015;
  let referenceQty=null,qty=0,capacityQty=0;
  const reasons=[...signal.reasons,...guard.reasons];
  if(!WATCHLIST.includes(symbol))reasons.push('本版只交易 SOXL、GDXU、BITX');
  if(!pos(equity))reasons.push('账户净值无效');
  if(!Number.isFinite(cash)||cash<0)reasons.push('请核对可用现金');
  if(!portfolio.valid)reasons.push('已有持仓数据待补齐：'+portfolio.unknown.join('、'));
  if(portfolio.positions.some(p=>p.symbol===symbol))reasons.push('该标的已有持仓，本版不重复加仓');
  if(portfolio.positions.length>=3)reasons.push('已有三笔持仓，先退出再开新仓');
  if(!levels.valid)reasons.push(...levels.errors);else{
    if(levels.tooWide)reasons.push('止损距离超过3倍小时ATR，放弃本笔');
    if(pos(equity))referenceQty=Math.max(0,Math.floor(Math.min(singleBudget/levels.distance,equity*.25/levels.entry)+EPS));
    if(referenceQty!==null&&portfolio.valid&&Number.isFinite(cash)&&cash>=0){
      capacityQty=Math.max(0,Math.floor(Math.min(referenceQty,(totalBudget-portfolio.risk)/levels.distance,(equity*cap-portfolio.value)/levels.entry,cash/levels.entry)+EPS));
      if(capacityQty===0)reasons.push('当前已确认趋势或现金／风险／仓位额度不足');
    }
  }
  if(!reasons.length)qty=capacityQty;
  return {symbol,levels,signal,guard,portfolio,equity,cash,qualified,unknown,trends,cap,singleBudget,totalBudget,referenceQty,capacityQty,qty,ready:reasons.length===0,reasons:[...new Set(reasons)]};
}
export function prepareDisciplineBuy(state,input,now=new Date().toISOString()){
  const symbol=input.symbol,raw=structuredClone(input.snapshot??state.workbench?.inputs?.[symbol]??{});
  if(!WATCHLIST.includes(symbol))throw Error('新纪律只支持 SOXL、GDXU、BITX。');
  if(!Number.isFinite(Date.parse(input.at))||Date.parse(input.at)>Date.parse(now)+60000)throw Error('成交时间无效或在未来。');
  if(!input.reason?.trim())throw Error('请填写一句话买入理由。');
  const levels=priceLevels(raw),price=num(input.price),qty=num(input.qty);
  if(!levels.valid||!pos(price)||!Number.isSafeInteger(qty)||qty<1||price<=levels.stop)throw Error('先填完整结构／ATR数据，并核对实际成交价、股数和止损。');
  const result=calculateWorkbench(state,symbol,raw,input.at),copy=structuredClone(state);
  copy.draft={...copy.draft,symbol,environment:'risk-on',strategy:'trend',checks:{},reason:input.reason.trim(),events:''};
  copy.draft.plan={...copy.draft.plan,equity:result.equity,entry:price,quantity:qty,amount:price*qty,stop:levels.stop,targetMode:'r',targetR:2,targetPrice:'',costs:0,gapPct:0};
  const r=newRound(copy),violations=[...result.reasons];
  const risk=qty*(price-levels.stop),totalValue=qty*price+result.portfolio.value;
  if(qty>result.capacityQty)violations.push('实际股数超过当前允许额度或入场条件未核对。');
  if(risk>result.singleBudget+EPS)violations.push('实际单笔初始风险超过净值0.5%。');
  if(risk+result.portfolio.risk>result.totalBudget+EPS)violations.push('实际合计计划风险超过净值1.5%。');
  if(qty*price>result.equity*.25+EPS||totalValue>result.equity*result.cap+EPS)violations.push('实际投入超过单只或趋势总仓位上限。');
  if(Number.isFinite(result.cash)&&qty*price>result.cash+EPS)violations.push('实际买入金额超过已核对现金。');
  r.createdAt=input.at;r.entrySource='actual';r.executionModel={mode:'atr-2r',asOf:DISCIPLINE.asOf,targetR:2,atr:levels.atr,low:levels.low,plannedEntry:levels.entry,stop:levels.stop,inputSnapshot:raw};
  r.exitPlan='结构/小时ATR初始止损；+2R全额止盈；+1R不操作；小时趋势失效或休市前退出。';
  r.checks=Object.fromEntries(Object.keys(r.checks).map(k=>[k,false]));
  const fill={id:uid(),sequence:0,at:input.at,side:'buy',kind:'entry',qty,price,fee:0,plannedPrice:levels.entry,targetPrice:null,reason:input.reason.trim(),reasonCode:'manual',trendConfirmed:result.signal.pass,violations:[...new Set(violations)]};
  r.fills=[fill];if(fill.violations.length)r.review.compliant=false;
  const after=accounting(r),check={after,violations:fill.violations,pass:!fill.violations.length};
  validateState({...state,rounds:[...state.rounds,r]});
  return {round:r,fill,check};
}
export function prepareDisciplineFill(state,id,input,now=new Date().toISOString()){
  const original=state.rounds.find(r=>r.id===id);if(!original)throw Error('交易不存在。');
  const r=structuredClone(original),old=input.editId?r.fills.find(f=>f.id===input.editId):null;
  if(input.editId&&!old)throw Error('待更正成交不存在。');
  if(!Number.isFinite(Date.parse(input.at))||Date.parse(input.at)>Date.parse(now)+60000)throw Error('成交时间无效或在未来。');
  const side=old?.side??input.side,qty=num(input.qty),price=num(input.price);
  if(!['buy','sell'].includes(side)||!Number.isSafeInteger(qty)||qty<1||!pos(price))throw Error('请核对实际成交价格和整股数。');
  if(side==='buy'&&!old)throw Error('已有持仓不加仓。');
  if(side==='buy'){
    if(price<=r.plan.stop)throw Error('更正买价必须高于已冻结止损；不下移止损。');
    Object.assign(r.plan,{entry:price,quantity:qty,amount:price*qty});r.initialRisk=rounded(qty*(price-r.plan.stop));
    if(input.reason?.trim())r.entryReason=input.reason.trim();
  }
  const beforeFills=r.fills.filter(f=>f.id!==old?.id),held=accounting({...r,fills:beforeFills.filter(f=>Date.parse(f.at)<=Date.parse(input.at))}).qty;
  const code=input.reasonCode??old?.reasonCode??'manual';
  if(!['manual','target','stop','structure','other'].includes(code))throw Error('退出原因无效。');
  const violations=[...(old?.violations??[])];
  if(side==='sell'){
    if(qty>held)throw Error('卖出股数超过该时点持仓。');
    if(qty<held)violations.push('部分卖出偏离本笔全额退出规则。');
    const target=Number(r.plan.entry)+2*(Number(r.plan.entry)-Number(r.plan.stop));
    if(!['stop','structure'].includes(code)&&price<target-.005)violations.push('未到+2R且未注明趋势/休市退出，需复核。');
  }else{
    const w=state.workbench??{equity:Number(r.plan.equity)},portfolio=disciplinePortfolio(state,now,id),e=num(w.equity);
    if(!portfolio.valid)violations.push('更正时其他持仓估值或风险未知，需复核。');
    if(r.initialRisk>e*.005+EPS||r.initialRisk+portfolio.risk>e*.015+EPS)violations.push('更正后超过单笔0.5%或合计1.5%风险上限。');
    if(price*qty>e*.25+EPS)violations.push('更正后单只市值超过净值25%。');
  }
  const fill={...old,id:old?.id??uid(),sequence:old?.sequence??Math.max(-1,...r.fills.map(f=>f.sequence))+1,at:input.at,side,qty,price,fee:old?.fee??0,plannedPrice:old?.plannedPrice??null,targetPrice:old?.targetPrice??null,kind:side==='buy'?'entry':qty===held?'exit':'partial',reason:input.reason?.trim()||old?.reason||code,reasonCode:code,trendConfirmed:old?.trendConfirmed??false,violations:[...new Set(violations)]};
  r.fills=[...beforeFills,fill];
  if(old&&side==='buy'){
    const target=Number(r.plan.entry)+2*(Number(r.plan.entry)-Number(r.plan.stop));
    for(const row of accounting(r).rows.filter(x=>x.side==='sell')){
      const f=r.fills.find(x=>x.id===row.id),flags=[...f.violations];
      if(row.remaining>0)flags.push('部分卖出偏离本笔全额退出规则。');
      if(!['stop','structure'].includes(f.reasonCode)&&f.price<target-.005)flags.push('更正买入后，该退出未到+2R且未注明趋势/休市退出。');
      f.violations=[...new Set(flags)];
    }
  }
  if(r.fills.some(f=>f.violations.length))r.review.compliant=false;
  const after=accounting(r);validateState({...state,rounds:state.rounds.map(x=>x.id===id?r:x)});
  return {round:r,fill,check:{after,violations:fill.violations,pass:!fill.violations.length}};
}
