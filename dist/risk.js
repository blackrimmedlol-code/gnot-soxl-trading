// v1.1: closing-equity risk cycles. No market data retrieval or order routing.
import {accounting,usDay,uid} from './core.js';
import {marketDay,marketClock,nextTradingDay} from './market.js';

const EPS=1e-8,stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const positive=v=>Number.isFinite(Number(v))&&Number(v)>0;
const dayBefore=day=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
export function ensureRisk(state){
  if(!state.workbench)throw Error('请先初始化交易工作台。');
  state.workbench.risk??={version:'1.1',baseline:null,closes:[],transitions:[]};
  return state.workbench.risk;
}
export function latestCloseDay(now=new Date().toISOString()){
  const c=marketClock(now);if(!c.valid||Number(c.day.slice(0,4))>2028)return null;
  let day=c.open&&c.minute>=c.close?c.day:dayBefore(c.day);
  for(let i=0;i<370;i++){if(marketDay(day))return day;day=dayBefore(day);}return null;
}
export function isClosingTime(at){const c=marketClock(at);return c.valid&&c.open&&c.minute===c.close&&new Date(at).getUTCSeconds()===0;}
export function closingISO(day){
  // Resolve the timezone by inspecting UTC candidates; handles EST/EDT and half days.
  for(const hour of [17,18,20,21]){const at=day+'T'+String(hour).padStart(2,'0')+':00:00.000Z';if(isClosingTime(at)&&usDay(at)===day)return at;}
  return null;
}
export function executionReview(round){
  if(round.fills.some(f=>f.violations.length)||round.review.compliant===false)return 'breach';
  if(round.fills.some(f=>(f.unverified??[]).length)||round.review.compliant!==true)return 'pending';
  return 'compliant';
}
export function disciplineGuard(state,now=new Date().toISOString()){
  const events=[],effective=Date.parse(state.workbench?.activatedAt??'2026-10-18T00:00:00+08:00');
  for(const r of state.rounds.filter(r=>r.scope==='active')){
    const a=accounting({...r,fills:r.fills.filter(f=>Date.parse(f.at)<=Date.parse(now))});
    if(a.closed&&Date.parse(a.exitAt)>=effective)events.push({at:a.exitAt,kind:a.realized<-EPS?'loss':a.realized>EPS?'win':'flat'});
    if(r.executionModel?.mode==='atr-2r')for(const f of r.fills)if(f.violations.length&&Date.parse(f.at)>=effective&&Date.parse(f.at)<=Date.parse(now))events.push({at:f.at,kind:'breach'});
    if(r.review.compliant===false&&stamp(r.review.reviewedAt)&&Date.parse(r.review.reviewedAt)<=Date.parse(now)&&!r.fills.some(f=>f.violations.length))events.push({at:r.review.reviewedAt,kind:'breach'});
  }
  events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||({win:0,flat:1,loss:2,breach:3}[a.kind]-{win:0,flat:1,loss:2,breach:3}[b.kind]));
  let streak=0,trigger=null,resumeDay=null;const triggers=[];
  const reviews=state.workbench?.recoveries??[];
  const reviewed=(after,before)=>reviews.some(r=>Date.parse(r.at)>=Date.parse(after)&&Date.parse(r.at)<=Date.parse(before)&&r.notes.trim().length>=10&&r.ordersResolved!==false);
  for(const event of events){
    if(trigger&&resumeDay&&usDay(event.at)>=resumeDay&&reviewed(trigger.at,event.at)){trigger=null;streak=0;resumeDay=null;}
    if(event.kind==='breach'){trigger=event;streak=0;}
    else if(!trigger){if(event.kind==='win')streak=0;else if(event.kind==='loss'&&++streak>=2)trigger=event;}
    if(trigger===event){triggers.push(event);const full=nextTradingDay(usDay(event.at),{full:true});resumeDay=full?nextTradingDay(full):null;}
  }
  const rested=!trigger||(resumeDay!==null&&usDay(now)>=resumeDay),hasReview=!trigger||reviewed(trigger.at,now),blocked=!!trigger&&(!rested||!hasReview);
  const reasons=blocked?[!rested?`连续亏损／违纪暂停；最早 ${resumeDay??'待更新交易日历'} 美东日期恢复。`:'休息期已满，完成恢复复盘并处理违纪仓位后再开仓。']:[];
  if(trigger&&rested&&hasReview)streak=0;
  return {blocked,reasons,streak,trigger,triggers,resumeDay,rested,reviewed:hasReview};
}
export function closeSeries(risk,now=new Date().toISOString()){
  if(!risk?.baseline)return {points:[],latest:null,error:'尚未核对 v1.1 启用净值'};
  const base=risk.baseline;if(!stamp(base.at)||!positive(base.equity)||Date.parse(base.at)>Date.parse(now))return {points:[],latest:null,error:'启用净值或时间无效'};
  let nav=1,previous=Number(base.equity),previousAt=base.at,peak=1,maxDD=0;
  const points=[{...base,id:'baseline',day:usDay(base.at),nav,normalized:Number(base.equity),drawdown:0,baseline:true}];
  const seen=new Set();
  for(const close of [...risk.closes].filter(c=>Date.parse(c.at)<=Date.parse(now)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){
    const pc=marketClock(previousAt),expected=points.length===1&&pc.open&&pc.minute<pc.close?pc.day:nextTradingDay(usDay(previousAt));
    if(usDay(close.at)!==expected)return {points,latest:points.at(-1),error:`请先补齐 ${expected??'有效交易日'} 收盘净值，不能跳过中间交易日。`};
    if(!isClosingTime(close.at)||!positive(close.equity)||Date.parse(close.at)<=Date.parse(previousAt)||seen.has(usDay(close.at)))return {points,latest:points.at(-1),error:'收盘净值时间、金额或重复交易日需核对'};
    seen.add(usDay(close.at));let factor=1,capital=previous,flowAt=previousAt;
    for(const flow of [...(close.flows??[])].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){
      if(!stamp(flow.at)||Date.parse(flow.at)<=Date.parse(flowAt)||Date.parse(flow.at)>Date.parse(close.at)||!Number.isFinite(Number(flow.amount))||!positive(flow.equityBefore)||Number(flow.equityBefore)+Number(flow.amount)<=0)return {points,latest:points.at(-1),error:'出入金须提供发生时刻及发生前净值，且时间顺序有效'};
      factor*=Number(flow.equityBefore)/capital;capital=Number(flow.equityBefore)+Number(flow.amount);flowAt=flow.at;
    }
    factor*=Number(close.equity)/capital;nav*=factor;
    if(!Number.isFinite(nav)||nav<=0)return {points,latest:points.at(-1),error:'归一化净值无效，请核对金额与出入金。'};
    peak=Math.max(peak,nav);const drawdown=Math.max(0,1-nav/peak);maxDD=Math.max(maxDD,drawdown);
    points.push({...close,day:usDay(close.at),nav,normalized:Number(base.equity)*nav,drawdown});previous=Number(close.equity);previousAt=close.at;
  }
  return {points,latest:points.at(-1),maxDD,currentDD:points.at(-1).drawdown,error:null};
}
function recoveryProgress(state,reducedAt,now,dd){
  const completed=state.rounds.filter(r=>r.executionModel?.ruleVersion==='1.1').map(r=>({round:r,a:accounting({...r,fills:r.fills.filter(f=>Date.parse(f.at)<=Date.parse(now))})})).filter(x=>x.a.closed&&Date.parse(x.a.entryAt)>=Date.parse(reducedAt??now)&&Date.parse(x.a.exitAt)<=Date.parse(now)).sort((a,b)=>Date.parse(a.a.exitAt)-Date.parse(b.a.exitAt));
  let consecutive=[];for(const x of completed){if(executionReview(x.round)==='compliant')consecutive.push(x);else consecutive=[];}
  const last=consecutive.slice(-5),sumR=last.reduce((s,x)=>s+(x.a.r??0),0),behavior=disciplineGuard(state,now),start=last[0]?.a.entryAt;
  const noPause=!!start&&!behavior.triggers.some(t=>Date.parse(t.at)>=Date.parse(start)&&Date.parse(t.at)<=Date.parse(now));
  const weekday=new Date(usDay(now)+'T12:00:00Z').getUTCDay(),weekend=weekday===0||weekday===6;
  return {count:last.length,sumR,drawdownOK:dd<.03-EPS,noPause,weekend,ready:dd<.03-EPS&&last.length===5&&sumR>EPS&&noPause&&!behavior.blocked&&weekend};
}
export function accountRisk(state,now=new Date().toISOString(),{ignoreTransitionsAfter=null}={}){
  const risk=state.workbench?.risk,series=closeSeries(risk,now),behavior=disciplineGuard(state,now);
  const pending=reason=>({known:false,mode:'pending',k:0,blocked:true,reasons:[reason],series,behavior,drawdown:null,historyDD:series.maxDD??null,progress:null,cycle:1});
  if(series.error)return pending(series.error);
  let peak=1,dd=0,mode='normal',reducedAt=null,trigger=null,cycle=1,cycleAt=risk.baseline.at;const audit=[];
  const transitions=(risk.transitions??[]).filter(t=>Date.parse(t.at)<=Date.parse(now)&&(!t.revokedAt||Date.parse(t.revokedAt)>Date.parse(now))&&(!ignoreTransitionsAfter||Date.parse(t.at)<Date.parse(ignoreTransitionsAfter)));
  const events=[...series.points.slice(1).map(p=>({kind:'close',at:p.at,p})),...transitions].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||(a.kind==='close'?-1:1));
  let last=series.points[0];
  for(const e of events){
    if(e.kind==='close'){
      last=e.p;peak=Math.max(peak,last.nav);dd=Math.max(0,1-last.nav/peak);
      if(dd>=.09-EPS&&mode!=='paused'){mode='paused';trigger={at:e.at,day:last.day};audit.push({kind:'pause',at:e.at,cycle});}
      else if(dd>=.06-EPS&&mode==='normal'){mode='reduced';reducedAt=e.at;audit.push({kind:'reduce',at:e.at,cycle});}
    }else if(e.kind==='restart'){
      const rest=trigger&&nextTradingDay(trigger.day,{full:true}),resume=rest&&nextTradingDay(rest);
      const open=state.rounds.some(r=>accounting({...r,fills:r.fills.filter(f=>Date.parse(f.at)<=Date.parse(e.at))}).qty>0);
      if(mode!=='paused'||!resume||usDay(e.at)<resume||open||e.anchorId!==last.id||!e.ordersChecked||!e.causeResolved||!e.cause||e.notes.trim().length<10){audit.push({kind:'invalid',at:e.at,id:e.id});continue;}
      peak=last.nav;dd=0;mode='reduced';reducedAt=e.at;cycleAt=e.at;cycle++;trigger=null;audit.push({kind:'restart',at:e.at,cycle});
    }else if(e.kind==='normal'){
      const p=recoveryProgress(state,reducedAt,e.at,dd);
      if(mode==='reduced'&&p.ready&&e.notes.trim().length>=10){mode='normal';reducedAt=null;audit.push({kind:'normal',at:e.at,cycle});}else audit.push({kind:'invalid',at:e.at,id:e.id});
    }
  }
  const expected=latestCloseDay(now),fresh=!!expected&&(usDay(last.at)>=expected||Date.parse(risk.baseline.at)>=Date.parse(closingISO(expected)));
  const reasons=[];if(!fresh)reasons.push(`缺少 ${expected??'有效交易日'} 的收盘净值，补齐后再核对风险档位。`);
  if(audit.some(x=>x.kind==='invalid'))reasons.push('历史恢复操作与现有数据不一致，请核对或恢复一致的备份。');
  if(mode==='paused')reasons.push('本风险周期收盘回撤达到9%，暂停新增；先休息、退出全部持仓并完成回撤复盘。');
  const progress=recoveryProgress(state,reducedAt,now,dd),known=fresh&&!audit.some(x=>x.kind==='invalid');
  const rest=trigger&&nextTradingDay(trigger.day,{full:true}),resumeDay=rest&&nextTradingDay(rest);
  return {known,mode:known?mode:'pending',underlyingMode:mode,k:known?(mode==='normal'?1:mode==='reduced'?.5:0):0,blocked:!known||mode==='paused',reasons,series,behavior,drawdown:dd,historyDD:series.maxDD,peak,cycle,cycleAt,reducedAt,trigger,resumeDay,progress,audit};
}
export function activateRisk(state,{equity,at,confirmed},now=new Date().toISOString()){
  const risk=ensureRisk(state);if(risk.baseline)throw Error('启用净值已保存；不能通过重复启用重设风险高点。');
  if(!confirmed||!positive(equity)||!stamp(at)||Date.parse(at)>Date.parse(now))throw Error('请确认真实启用净值和有效时间。');
  risk.baseline={at,equity:Number(equity),verified:true};return risk;
}
export function addRiskClose(state,{day,equity,flows=[],note=''},now=new Date().toISOString()){
  const risk=ensureRisk(state),at=closingISO(day);if(!risk.baseline)throw Error('请先核对启用净值。');
  if(!at||Date.parse(at)>Date.parse(now)||Date.parse(at)<=Date.parse(risk.baseline.at)||!positive(equity))throw Error('请填写启用后已经结束交易日的真实收盘净值。');
  if(risk.closes.some(c=>usDay(c.at)===day))throw Error('该交易日已有记录；请核对现有记录，不重复录入。');
  const row={id:uid(),at,equity:Number(equity),flows:structuredClone(flows),note};risk.closes.push(row);
  const series=closeSeries(risk,now);if(series.error){risk.closes.pop();throw Error(series.error);}return row;
}
export function correctRiskClose(state,id,{equity,flows=[],note},now=new Date().toISOString()){
  const risk=ensureRisk(state),index=risk.closes.findIndex(c=>c.id===id);if(index<0||!positive(equity)||typeof note!=='string')throw Error('待更正收盘记录或金额无效。');
  const old=structuredClone(risk.closes[index]);
  risk.closes[index]={...old,equity:Number(equity),flows:structuredClone(flows),note,corrections:[...(old.corrections??[]),{at:now,equity:old.equity,flows:old.flows,note:old.note}]};
  const series=closeSeries(risk,now);if(series.error){risk.closes[index]=old;throw Error(series.error);}return risk.closes[index];
}
export function revokeInvalidTransition(state,id,notes,now=new Date().toISOString()){
  const r=accountRisk(state,now);if(!r.audit?.some(e=>e.kind==='invalid'&&e.id===id)||typeof notes!=='string'||notes.trim().length<10)throw Error('仅可撤回已失效的恢复操作，须填写更正原因。');
  const event=ensureRisk(state).transitions.find(e=>e.id===id);event.revokedAt=now;event.revokedReason=notes.trim();return event;
}
export function transitionRisk(state,{kind,notes,cause,ordersChecked,causeResolved},now=new Date().toISOString()){
  const r=accountRisk(state,now);if(!r.known||!notes?.trim()||notes.trim().length<10)throw Error('先补齐净值，并填写至少10字的可执行复盘。');
  if(kind==='normal'){
    if(r.underlyingMode!=='reduced'||!r.progress.ready)throw Error('恢复常规档须同时满足：回撤<3%、连续5笔合规交易且合计R>0、期间无暂停、周末复盘。');
  }else if(kind==='restart'){
    if(r.underlyingMode!=='paused'||!r.resumeDay||usDay(now)<r.resumeDay)throw Error('账户回撤暂停仍须完整休息下一个正常交易日。');
    if(state.rounds.some(x=>accounting(x).qty>0))throw Error('退出全部既有持仓后，才可重启风险周期。');
    if(!ordersChecked||!causeResolved||!['strategy','breach','gap','mixed'].includes(cause))throw Error('请区分损失原因，确认问题已处理、数据及订单正常。');
  }else throw Error('恢复操作无效。');
  const event={id:uid(),kind,at:now,notes:notes.trim(),anchorId:r.series.latest.id,cause:cause??'',ordersChecked:!!ordersChecked,causeResolved:!!causeResolved};
  ensureRisk(state).transitions.push(event);return event;
}
export function weeklyReview(state,now=new Date().toISOString(),symbol='all'){
  const today=usDay(now),dow=new Date(today+'T12:00:00Z').getUTCDay(),monday=new Date(Date.parse(today+'T12:00:00Z')-((dow+6)%7)*86400000).toISOString().slice(0,10);
  const rows=state.rounds.filter(r=>r.scope==='active'&&r.executionModel?.ruleVersion==='1.1'&&(symbol==='all'||r.symbol===symbol)).map(round=>({round,a:accounting(round)})).filter(x=>x.a.closed&&usDay(x.a.exitAt)>=monday&&Date.parse(x.a.exitAt)<=Date.parse(now));
  const judged=rows.filter(x=>executionReview(x.round)!=='pending'),ok=judged.filter(x=>executionReview(x.round)==='compliant');
  return {monday,rows,total:rows.length,pending:rows.length-judged.length,compliance:judged.length?ok.length/judged.length:null,avgR:rows.length?rows.reduce((n,x)=>n+x.a.r,0)/rows.length:null};
}
