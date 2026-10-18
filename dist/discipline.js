import {effectiveMarketInput,currentAutoHour} from './trend-feed.js';
// 2026-10-18 strategy. Pure calculations; never retrieves prices or routes orders.
import {accounting, positionRisk, newRound, uid, usDay, validateState} from './core.js';

export const WATCHLIST=['SOXL','GDXU','BITX'];
export const DISCIPLINE=Object.freeze({asOf:'2026-10-18',initialEquity:30000,riskPct:.015,totalRiskPct:.03,singlePct:.25,maxPct:.60});
const EPS=1e-8, num=v=>v===''||v==null?NaN:Number(v), pos=v=>Number.isFinite(num(v))&&num(v)>0;
const rounded=v=>Number(v.toFixed(8));
import {marketDay,nextTradingDay,marketClock} from './market.js';
export {marketDay,nextTradingDay,marketClock} from './market.js';
import {accountRisk,disciplineGuard,executionReview} from './risk.js';
export {disciplineGuard} from './risk.js';
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
  if(input.trendOrigin==='auto'&&!currentAutoHour(input.hourAt,now))return {known:false,pass:false,reason:'自动小时快照已过期或当前休市，更新或切换手动核对'};
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
  if(input.trendOrigin==='auto'&&Number.isFinite(Date.parse(input.trendGeneratedAt))&&Date.parse(input.trendGeneratedAt)>Date.parse(now))reasons.push('自动快照生成晚于本笔时刻，不能证明事前已核对');
  return {pass:reasons.length===0,trend,breakout,fresh,signalTime,clock,reasons};
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
export function calculateWorkbench(state,symbol,input=undefined,now=new Date().toISOString(),excludeId=null){
  input??=effectiveMarketInput(state,symbol,now);
  const w=state.workbench??{equity:30000,cash:'',inputs:{}},equity=num(w.equity),cash=num(w.cash),levels=priceLevels(input),signal=entrySignal(input,now),guard=disciplineGuard(state,now),portfolio=disciplinePortfolio(state,now,excludeId);
  const trends=WATCHLIST.map(s=>({symbol:s,...trendState(s===symbol?input:effectiveMarketInput(state,s,now),now)})),qualified=trends.filter(x=>x.known&&x.pass).length,unknown=trends.filter(x=>!x.known).length;
  const account=accountRisk(state,now),cap=[0,.25,.5,.6][qualified],singleBudget=equity*.015*(guard.blocked?0:account.k),totalBudget=equity*.03*(guard.blocked?0:account.k);
  let referenceQty=null,qty=0,capacityQty=0;const limits=[];
  const reasons=[...signal.reasons,...guard.reasons,...account.reasons];
  if(w.equityDay!==usDay(now))reasons.push('请确认该美东交易日的开盘净值与可用现金');
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
      limits.push({name:'单笔及组合风险',qty:Math.min(singleBudget,totalBudget-portfolio.risk)/levels.distance},{name:'单只25%市值',qty:equity*.25/levels.entry},{name:'趋势总仓位',qty:(equity*cap-portfolio.value)/levels.entry},{name:'可用现金',qty:cash/levels.entry});
      capacityQty=Math.max(0,Math.floor(Math.min(...limits.map(x=>x.qty))+EPS));
      if(capacityQty===0)reasons.push('当前已确认趋势或现金／风险／仓位额度不足');
    }
  }
  const chosen=input.requestedQty===''||input.requestedQty==null?capacityQty:Number(input.requestedQty);
  if(!Number.isSafeInteger(chosen)||chosen<1||chosen>capacityQty)reasons.push('本次股数须为允许上限内的正整股数');
  if(!reasons.length)qty=chosen;
  return {symbol,inputSnapshot:structuredClone(input),levels,signal,guard,account,portfolio,equity,cash,qualified,unknown,trends,cap,singleBudget,totalBudget,referenceQty,capacityQty,limits,limiting:limits.length?limits.filter(x=>Math.floor(x.qty+EPS)===Math.min(...limits.map(y=>Math.floor(y.qty+EPS)))).map(x=>x.name).join('、'):'资料待核对',qty,ready:reasons.length===0,reasons:[...new Set(reasons)]};
}
export function prepareDisciplineBuy(state,input,now=new Date().toISOString()){
  const symbol=input.symbol,raw=structuredClone(input.snapshot??effectiveMarketInput(state,symbol,input.at));
  if(!WATCHLIST.includes(symbol))throw Error('新纪律只支持 SOXL、GDXU、BITX。');
  if(!Number.isFinite(Date.parse(input.at))||Date.parse(input.at)>Date.parse(now)+60000)throw Error('成交时间无效或在未来。');
  if(!input.reason?.trim())throw Error('请填写一句话买入理由。');
  const levels=priceLevels(raw),price=num(input.price),qty=num(input.qty);
  if(!levels.valid||!pos(price)||!Number.isSafeInteger(qty)||qty<1||price<=levels.stop)throw Error('先填完整结构／ATR数据，并核对实际成交价、股数和止损。');
  const result=calculateWorkbench(state,symbol,raw,input.at),copy=structuredClone(state);
  copy.draft={...copy.draft,symbol,environment:'risk-on',strategy:'trend',checks:{},reason:input.reason.trim(),events:''};
  copy.draft.plan={...copy.draft.plan,equity:result.equity,entry:price,quantity:qty,amount:price*qty,stop:levels.stop,targetMode:'r',targetR:2,targetPrice:'',costs:0,gapPct:0};
  const r=newRound(copy),violations=[],unverified=[];
  if(Number.isSafeInteger(raw.authorizedQty)&&qty>raw.authorizedQty)violations.push('实际股数超过入场前已核对的股数，不追补。');
  if(result.signal.trend.known&&!result.signal.trend.pass)violations.push('小时趋势不合格仍买入。');
  if(result.signal.breakout===false)violations.push('30分钟未突破仍买入。');
  if(result.guard.blocked)violations.push(...result.guard.reasons);
  if(result.account.known&&result.account.underlyingMode==='paused')violations.push('账户回撤暂停期间买入。');
  if(result.portfolio.positions.some(x=>x.symbol===symbol))violations.push('已有同标的持仓仍重复买入。');
  if(result.portfolio.positions.length>=3)violations.push('超过三笔持仓。');
  if(!result.signal.clock.entry)violations.push('不在正常开仓窗口仍买入。');
  for(const reason of result.reasons)if(!violations.includes(reason))unverified.push(reason);
  const risk=qty*(price-levels.stop),totalValue=qty*price+result.portfolio.value;
  if(result.account.known&&result.unknown===0&&result.portfolio.valid&&Number.isFinite(result.cash)&&qty>result.capacityQty)violations.push('实际股数超过当前可用额度。');
  if(result.account.known&&risk>result.singleBudget+EPS)violations.push(`实际单笔初始风险超过当前档位${(result.singleBudget/result.equity*100).toFixed(2)}%。`);
  if(result.account.known&&result.portfolio.valid&&risk+result.portfolio.risk>result.totalBudget+EPS)violations.push(`实际合计计划风险超过当前档位${(result.totalBudget/result.equity*100).toFixed(2)}%。`);
  if(qty*price>result.equity*.25+EPS||result.portfolio.valid&&(totalValue>result.equity*.6+EPS||result.unknown===0&&totalValue>result.equity*result.cap+EPS))violations.push('实际投入超过单只或趋势总仓位上限。');
  if(Number.isFinite(result.cash)&&qty*price>result.cash+EPS)violations.push('实际买入金额超过已核对现金。');
  r.createdAt=input.at;r.entrySource='actual';r.executionModel={mode:'atr-2r',ruleVersion:'1.1',riskSnapshot:{k:result.equity>0?result.singleBudget/(result.equity*.015):0,equity:result.equity,singleBudget:result.singleBudget,totalBudget:result.totalBudget,cycle:result.account.cycle,at:input.at},asOf:DISCIPLINE.asOf,targetR:2,atr:levels.atr,low:levels.low,plannedEntry:levels.entry,stop:levels.stop,inputSnapshot:raw};
  r.exitPlan='结构/小时ATR初始止损；+2R全额止盈；+1R不操作；小时趋势失效或休市前退出。';
  r.checks=Object.fromEntries(Object.keys(r.checks).map(k=>[k,false]));
  const fill={id:uid(),sequence:0,at:input.at,side:'buy',kind:'entry',qty,price,fee:0,plannedPrice:levels.entry,targetPrice:null,reason:input.reason.trim(),reasonCode:'manual',trendConfirmed:result.signal.pass,unverified:[...new Set(unverified)],violations:[...new Set(violations)]};
  r.fills=[fill];if(fill.violations.length)r.review.compliant=false;
  const after=accounting(r),check={after,violations:[...fill.violations,...fill.unverified],pass:!fill.violations.length&&!fill.unverified.length};
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
    const w=state.workbench??{equity:Number(r.plan.equity)},portfolio=disciplinePortfolio(state,now,id),frozen=r.executionModel.riskSnapshot,e=num(frozen?.equity??r.plan.equity),single=frozen?.singleBudget??e*.005,total=frozen?.totalBudget??e*.015;
    if(!portfolio.valid)violations.push('更正时其他持仓估值或风险未知，需复核。');
    if(Number.isSafeInteger(r.executionModel.inputSnapshot?.authorizedQty)&&qty>r.executionModel.inputSnapshot.authorizedQty)violations.push('更正股数超过入场前已核对股数。');
    if(r.initialRisk>single+EPS||r.initialRisk+portfolio.risk>total+EPS)violations.push('更正后超过本笔冻结风险档位预算。');
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
