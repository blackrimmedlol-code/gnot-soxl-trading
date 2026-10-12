// Pure, dependency-free financial functions. No market data or order routing.
export const SCHEMA_VERSION = 1;
export const RULES = Object.freeze({riskPct: .01, initialEquity: 25000, initialAmount: 5000, minNetRR: 1.5, pauseDD: .05, haltDD: .10});
export const SYMBOLS = Object.freeze({
  SOXL: {name:'半导体', leverage:'3× DAILY', reference:'QQQ／SOXX', url:'https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs', note:'半导体每日三倍。SOXX 为观察参考，实际基准以发行方为准。'},
  AGQ: {name:'白银', leverage:'2× DAILY', reference:'白银期货／SLV', url:'https://www.proshares.com/our-etfs/leveraged-and-inverse/agq', note:'白银期货指数每日两倍。SLV 仅作观察参考；期货展期、隔夜行情与现货可能产生差异。'},
  LABU: {name:'生物科技', leverage:'3× DAILY', reference:'XBI', url:'https://www.direxion.com/product/daily-sp-biotech-bull-bear-3x-etfs', note:'生物科技指数每日三倍。用 XBI 观察板块，评估研发、审批、融资与隔夜风险。'},
  MSTU: {name:'MSTR', leverage:'2× DAILY', reference:'MSTR／BTC', url:'https://www.rexshares.com/mstu/', note:'MSTR 单只股票每日两倍，并非比特币指数。MSTR 结构需独立确认，另评估 BTC 全天／周末行情及公司事件。'}
});
export const CHECKS = [
  ['market', 'QQQ／SOXX 日线环境支持此次交易'],
  ['soxx', 'SOXX 已止跌，没有持续破位下跌'],
  ['support', '已识别 SOXL 大级别支撑'],
  ['signal', '30 分钟结构、15 分钟入场信号已确认'],
  ['stop', '技术止损基于支撑失效，已确定退出方式'],
  ['risk', '计划风险不超过账户 1%'],
  ['reward', '有至少 1.5R 的合理盈利空间'],
  ['event', 'CPI／FOMC／龙头财报与隔夜风险已评估'],
  ['emotion', '已排除恐惧、报复交易与 FOMO 的影响']
];
export function checksFor(symbol='SOXL') {
  const overrides={
    SOXL:{risk:'本轮与已有持仓合计计划风险不超过账户 1%'},
    AGQ:{market:'白银期货／SLV 日线环境支持此次交易',soxx:'白银走势已止跌，没有持续破位下跌',support:'已识别 AGQ 大级别支撑',event:'美元／利率、白银隔夜行情与事件风险已评估',risk:'本轮与已有持仓合计计划风险不超过账户 1%'},
    LABU:{market:'XBI 日线环境与生物科技板块支持此次交易',soxx:'XBI 已止跌，没有持续破位下跌',support:'已识别 LABU 大级别支撑',event:'利率／融资、研发审批与隔夜风险已评估',risk:'本轮与已有持仓合计计划风险不超过账户 1%'},
    MSTU:{market:'MSTR 日线与 BTC 背景支持此次交易',soxx:'MSTR 已止跌，没有持续破位下跌',support:'已识别 MSTU 大级别支撑',event:'MSTR 公司事件／融资、BTC 隔夜与周末风险已评估',risk:'本轮与已有持仓合计计划风险不超过账户 1%'}
  };
  return CHECKS.map(([key,text])=>[key,overrides[symbol]?.[key]??text]);
}
export function selectDraft(state,symbol) {
  if(!Object.hasOwn(SYMBOLS,symbol)) throw Error('只支持 SOXL、AGQ、LABU、MSTU。');
  const next=structuredClone(state),previous=next.draft.symbol??'SOXL';
  next.symbolDrafts??={};next.symbolDrafts[previous]=structuredClone(next.draft);
  next.draft=structuredClone(next.symbolDrafts[symbol]??defaultState().draft);
  next.draft.symbol=symbol;
  // Account equity is shared; prices, checks and reasons belong to each symbol.
  next.draft.plan.equity=state.draft.plan.equity;
  return next;
}
const EPS = 1e-8;
const n = v => (v === '' || v === null || v === undefined) ? NaN : Number(v);
const finite = v => Number.isFinite(v);
const positive = v => finite(v) && v > 0;
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `gnot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function defaultState() {
  return {schemaVersion:1, revision:0, settings:{initialEquity:25000, startDate:'2026-11-01'}, rounds:[], snapshots:[], drawdownReviews:[], draft:{symbol:'SOXL',plan:{equity:25000, amount:5000, entry:'', stop:'', targetMode:'r', targetR:2, targetPrice:'', costs:0, gapPct:0, scenarioPct:5}, environment:'neutral', strategy:'support', checks:{}, reason:'', events:''}, meta:{updatedAt:null, lastExport:null}};
}
export function calculatePlan(input) {
  const equity=n(input.equity), amount=n(input.amount), entry=n(input.entry), stop=n(input.stop), costs=n(input.costs), gapPct=n(input.gapPct), targetR=n(input.targetR);
  const errors=[];
  if(!positive(equity)) errors.push('账户权益必须大于 0。');
  if(!positive(amount)) errors.push('计划金额必须大于 0。');
  if(!positive(entry)) errors.push('请输入大于 0 的计划买入价。');
  if(!positive(stop) || stop >= entry) errors.push('技术止损必须大于 0，且低于买入价。');
  if(!finite(costs) || costs<0) errors.push('预估往返费用不能为负数。');
  if(!finite(gapPct) || gapPct<0 || gapPct>100) errors.push('止损额外滑点／跳空需在 0%～100%。');
  if(input.targetMode!=='price' && (!positive(targetR))) errors.push('目标 R 必须大于 0。');
  const target = input.targetMode==='price' ? n(input.targetPrice) : entry + (entry-stop)*targetR;
  if(!positive(target) || target<=entry) errors.push('目标价格必须高于买入价。');
  if(errors.length) return {valid:false, errors, violations:[], pass:false};
  const qty=Math.floor((amount+EPS)/entry);
  if(qty<1) return {valid:false,errors:['计划金额不足以买入 1 股。'],violations:[],pass:false};
  const invested=qty*entry, priceRisk=qty*(entry-stop), risk=priceRisk+costs, budget=equity*RULES.riskPct;
  const gain=qty*(target-entry)-costs, netRR=gain/risk;
  const stressedStop=Math.max(0,stop*(1-gapPct/100));
  const stressLoss=qty*(entry-stressedStop)+costs;
  const violations=[];
  if(amount>equity+EPS) violations.push('计划投入金额超过账户权益。');
  if(risk>budget+EPS) violations.push(`单轮计划亏损超过账户权益 1%：预算 ${budget.toFixed(2)} USD。默认放弃交易。`);
  if(netRR+EPS<RULES.minNetRR) violations.push('目标收益风险比不足 1.5R。');
  return {valid:true, errors:[], pass:!violations.length,violations,qty,invested,unspent:amount-invested,positionPct:invested/equity,stopPct:(entry-stop)/entry,priceRisk,risk,budget,riskPct:risk/equity,target,netRR,gain,target15:entry+1.5*(entry-stop),target2:entry+2*(entry-stop),stressedStop,stressLoss,stressPct:stressLoss/equity,costs};
}
export function scenario(plan, pct) {
  const c=calculatePlan(plan); if(!c.valid) return null;
  const price=Math.max(0,Number(plan.entry)*(1+Number(pct)/100));
  const net=(price-Number(plan.entry))*c.qty-c.costs;
  return {price, net, r:net/c.risk};
}
export function sortFills(fills) {return [...fills].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));}
export function accounting(round) {
  let qty=0, basis=0, realized=0, fees=0, bought=0, sold=0, buysValue=0, saleValue=0;
  let entryAt=null, exitAt=null;
  const rows=[];
  for(const f of sortFills(round.fills??[])) {
    if(!positive(f.price)||!Number.isInteger(f.qty)||f.qty<1||!finite(f.fee)||f.fee<0) throw Error('成交价格、整股数量或手续费无效。');
    const avg=qty?basis/qty:0;
    let pnl=0;
    if(f.side==='buy') {
      if(qty===0 && bought>0) throw Error('已全部退出的交易轮不能再次买入，请新建一轮。');
      qty+=f.qty; basis+=f.qty*f.price+f.fee; bought+=f.qty; buysValue+=f.qty*f.price;
      entryAt??=f.at;
    } else if(f.side==='sell') {
      if(f.qty>qty) throw Error('卖出股数超过当时剩余股数。');
      pnl=f.qty*(f.price-avg)-f.fee;
      realized+=pnl; basis-=avg*f.qty; qty-=f.qty; sold+=f.qty; saleValue+=f.qty*f.price;
      if(qty===0) {basis=0;exitAt=f.at;}
    } else throw Error('成交方向无效。');
    fees+=f.fee;
    rows.push({...f,pnl,remaining:qty,avg:qty?basis/qty:null,realized});
  }
  const mark=positive(round.mark?.price)?round.mark.price:null;
  const unrealized=qty===0?0:mark===null?null:qty*mark-basis;
  return {qty,basis,avg:qty?basis/qty:null,realized,unrealized,total:unrealized===null?null:realized+unrealized,fees,bought,sold,buysValue,saleValue,closed:bought>0&&qty===0,entryAt,exitAt,rows,r:positive(round.initialRisk)?realized/round.initialRisk:null};
}
export function effectiveStop(round, asOf=null) {
  const events=[...(round.stopEvents??[])].filter(x=>!asOf || Date.parse(x.at)<=Date.parse(asOf)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  return events.at(-1)?.price ?? n(round.plan.stop);
}
export function breakevenStop(round) {
  const a=accounting(round),stop=effectiveStop(round);
  if(!a.qty||!positive(a.avg))return null;
  const price=Math.max(a.avg,positive(stop)?stop:0);
  // Round upward to the entry form's price precision; never lower an existing stop.
  return {price:Math.ceil(price*10000)/10000,average:a.avg,currentStop:positive(stop)?stop:null,qty:a.qty};
}
export function positionRisk(round, options={}) {
  const a=accounting(round), stop=options.stop??effectiveStop(round), exitFee=options.exitFee??Number(round.plan.costs)/2;
  if(!a.qty) return {valid:true,remainingRisk:0,roundLoss:Math.max(0,-a.realized),roundNetAtStop:a.realized,risk:Math.max(0,-a.realized)};
  if(!positive(stop) || !finite(exitFee) || exitFee<0) return {valid:false};
  const remainingRisk=Math.max(0,a.basis-a.qty*stop)+exitFee;
  const roundNetAtStop=a.realized+a.qty*stop-a.basis-exitFee;
  return {valid:true,stop,remainingRisk,roundLoss:Math.max(0,-roundNetAtStop),roundNetAtStop,risk:Math.max(remainingRisk,-roundNetAtStop,0)};
}
export function portfolioRisk(state,{excludeId=null,asOf=null}={}) {
  let risk=0;const positions=[],unknown=[];
  for(const original of state.rounds.filter(r=>r.scope==='active'&&r.id!==excludeId)) {
    const r=asOf?{...original,fills:original.fills.filter(f=>Date.parse(f.at)<=Date.parse(asOf))}:original;
    if(!accounting(r).qty)continue;
    const p=positionRisk(r,{stop:effectiveStop(r,asOf)});
    if(!p.valid){unknown.push(r.symbol);continue;}
    risk+=p.risk;positions.push({id:r.id,symbol:r.symbol,risk:p.risk});
  }
  return {valid:!unknown.length,risk,positions,unknown};
}
export function calculateDraft(state) {
  const c=calculatePlan(state.draft.plan),portfolio=portfolioRisk(state);
  if(!c.valid)return {...c,portfolio};
  const violations=[...c.violations];
  if(!portfolio.valid)violations.push('已有持仓风险无法计算，请先补齐有效止损。');
  if(portfolio.risk+c.risk>c.budget+EPS)violations.push('新计划与已有主动持仓合计风险超过账户权益 1%。');
  return {...c,portfolio,combinedRisk:portfolio.risk+c.risk,availableRisk:Math.max(0,c.budget-portfolio.risk),violations,pass:!violations.length};
}
export function previewFill(round, fill, options={}) {
  const before=accounting(round);
  const after=accounting({...round,fills:[...round.fills,fill]});
  const violations=[];
  const stop=effectiveStop(round,fill.at), budget=Number(round.plan.equity)*RULES.riskPct;
  const rp=positionRisk({...round,fills:[...round.fills,fill]}, {stop});
  if(fill.side==='buy' && round.scope==='active') {
    if(fill.price<=stop) violations.push('实际买入价必须高于有效技术止损。');
    if(before.qty===0 && fill.kind==='add') violations.push('没有盈利的原有仓位，不能标记右侧加仓。');
    if(before.qty>0 && fill.kind==='add') {
      if(fill.price<=before.avg+EPS) violations.push('原有仓位未盈利，不允许下跌补仓。');
      if(!fill.trendConfirmed) violations.push('右侧加仓缺少趋势重新确认。');
    }
    if(fill.kind!=='add') {
      const prior=round.fills.filter(f=>f.side==='buy'&&f.kind!=='add').reduce((s,f)=>s+f.price*f.qty,0);
      if(prior+fill.price*fill.qty>Number(round.plan.amount)+EPS) violations.push('首笔及其分次成交的投入金额超过该轮计划金额。');
    }
    if(rp.risk>budget+EPS) violations.push('成交后整轮风险超过锁定账户权益的 1%。');
    if(options.currentEquity && rp.risk>options.currentEquity*RULES.riskPct+EPS) violations.push('成交后整轮风险超过当前账户权益的 1%。');
    if(options.portfolio){
      if(!options.portfolio.valid)violations.push('其他主动持仓风险未知，无法确认账户风险预算。');
      if(options.portfolio.risk+rp.risk>(options.currentEquity??Number(round.plan.equity))*RULES.riskPct+EPS)violations.push('成交后四标的合计计划风险超过账户权益 1%。');
    }
    const planned=calculatePlan(round.plan);
    if(!planned.pass) violations.push(...planned.violations,...planned.errors);
    const target=fill.targetPrice??planned.target;
    const remainingReward=after.qty*target-after.basis-Number(round.plan.costs)/2;
    if(!positive(target)||target<=fill.price) violations.push('实际买入后的目标价格必须高于本笔买入价；右侧加仓需重新评估目标空间。');
    else if(rp.risk>EPS && remainingReward/rp.risk+EPS<RULES.minNetRR) violations.push('按实际成交价与当前止损计算，剩余仓位扣费后目标空间不足 1.5R。');
    if(!CHECKS.every(([id])=>round.checks[id]===true)) violations.push('该轮入场检查清单尚未全部确认。');
    if(!round.entryReason.trim()) violations.push('缺少入场依据。');
    if(!round.events.trim()) violations.push('缺少重大事件与隔夜风险评估。');
    if(!round.exitPlan.trim()) violations.push('持仓必须有明确的退出规则。');
    if(round.environment==='risk-off' && round.strategy==='support') violations.push('Risk-off：原则上不开新的左侧支撑反弹多头。');
    if(options.guard?.blocked) violations.push(...options.guard.reasons);
    if(options.otherOpen) violations.push(`已有另一轮 ${round.symbol} 持仓，请在同一轮记录成交或先退出。`);
  }
  return {before,after,risk:rp,budget,violations:[...new Set(violations)],pass:!violations.length};
}
export function usDay(at) {return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
export function snapshotSeries(state) {
  const base=state.settings.initialEquity;
  let units=base, nav=1, peak=1, maxDD=0;
  const points=[{at:state.settings.startDate+'T00:00:00+08:00',equity:base,nav:1,normalized:base,drawdown:0,flow:0,initial:true}];
  for(const s of [...state.snapshots].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
    const before=s.equity-s.flow;
    if(before<=0 || units<=0) throw Error('出入金调整前权益必须为正数，请检查权益快照。');
    nav=before/units; units=s.equity/nav; peak=Math.max(peak,nav);
    const drawdown=(peak-nav)/peak; maxDD=Math.max(maxDD,drawdown);
    points.push({...s,nav,normalized:base*nav,drawdown});
  }
  return {points,maxDD,currentDD:points.at(-1).drawdown,latest:state.snapshots.length?points.at(-1):null};
}
export function statistics(state,symbol='all') {
  const active=state.rounds.filter(r=>r.scope==='active'&&(symbol==='all'||r.symbol===symbol));
  const closed=active.map(r=>({round:r,a:accounting(r)})).filter(x=>x.a.closed).sort((x,y)=>Date.parse(x.a.exitAt)-Date.parse(y.a.exitAt));
  const wins=closed.filter(x=>x.a.realized>EPS), losses=closed.filter(x=>x.a.realized<-EPS), flat=closed.length-wins.length-losses.length;
  const rs=closed.filter(x=>positive(x.round.initialRisk));
  const winR=rs.filter(x=>x.a.realized>EPS).map(x=>x.a.r), lossR=rs.filter(x=>x.a.realized<-EPS).map(x=>Math.abs(x.a.r));
  const avg=arr=>arr.length?arr.reduce((s,x)=>s+x,0)/arr.length:null;
  let streak=0, maxStreak=0;
  for(const x of closed) {streak=x.a.realized<-EPS?streak+1:0;maxStreak=Math.max(maxStreak,streak);}
  const known=closed.filter(x=>typeof x.round.review.compliant==='boolean');
  const compliant=known.filter(x=>x.round.review.compliant===true && !(x.round.fills??[]).some(f=>(f.violations??[]).length)).length;
  const realized=active.reduce((s,r)=>s+accounting(r).realized,0);
  const open=active.filter(r=>accounting(r).qty>0);
  const marksMissing=open.some(r=>accounting(r).unrealized===null);
  const unrealized=marksMissing?null:open.reduce((s,r)=>s+accounting(r).unrealized,0);
  const dollarWin=avg(wins.map(x=>x.a.realized)), dollarLoss=avg(losses.map(x=>-x.a.realized));
  return {closed,wins:wins.length,losses:losses.length,flat,total:closed.length,realized,unrealized,net:unrealized===null?null:realized+unrealized,winRate:closed.length?wins.length/closed.length:null,avgWinR:avg(winR),avgLossR:avg(lossR),payoff:dollarWin!==null&&dollarLoss!==null?dollarWin/dollarLoss:null,expectancyR:avg(rs.map(x=>x.a.r)),expectancy:closed.length?closed.reduce((s,x)=>s+x.a.realized,0)/closed.length:null,streak,maxStreak,compliance:known.length?compliant/known.length:null,reviewCount:known.length,rCount:rs.length,sampleInsufficient:closed.length<30,snapshots:snapshotSeries(state)};
}
export function tradingGuard(state, now=new Date().toISOString()) {
  const s=statistics(state), reasons=[];
  // A pause is latched for the full US trading date after any two consecutive stop exits.
  const day=usDay(now);
  let stopStreak=0, pausedToday=false;
  for(const x of s.closed.filter(x=>Date.parse(x.a.exitAt)<=Date.parse(now) && usDay(x.a.exitAt)===day)) {
    const stopped=x.a.realized<-EPS&&x.round.fills.some(f=>f.side==='sell'&&f.reasonCode==='stop');
    stopStreak=stopped?stopStreak+1:0;
    if(stopStreak>=2) pausedToday=true;
  }
  if(pausedToday) reasons.push('美东当日已出现连续两轮止损：暂停当天新开仓。');
  const visible={...state,snapshots:state.snapshots.filter(x=>Date.parse(x.at)<=Date.parse(now))};
  const curve=snapshotSeries(visible);
  if(curve.maxDD+EPS>=RULES.haltDD) reasons.push('账户权益快照曾触及 10% 回撤：停止主动开仓，重新评估系统。V1 不提供自动解除。');
  else if(curve.maxDD+EPS>=RULES.pauseDD) {
    const breach=curve.points.filter(x=>x.drawdown+EPS>=RULES.pauseDD).at(-1);
    const review=(state.drawdownReviews??[]).some(r=>Date.parse(r.at)>=Date.parse(breach.at)&&Date.parse(r.at)<=Date.parse(now)&&r.notes.trim().length>=10);
    if(!review) reasons.push('账户权益快照触及 5% 回撤：暂停交易，先记录复核结论。');
  }
  return {blocked:reasons.length>0,reasons,pausedToday,drawdown:curve.currentDD,snapshotsMissing:!curve.latest};
}
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const string=(v,max=20000)=>typeof v==='string'&&v.length<=max;
const stamp=x=>typeof x==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(x)&&finite(Date.parse(x));
function assert(c,message) {if(!c)throw Error(message);}
export function validateState(input) {
  assert(obj(input)&&input.schemaVersion===1,'不支持的备份版本。请使用 GNOT V1 JSON／备份 CSV。');
  assert(obj(input.settings)&&input.settings.initialEquity===25000,'V1 初始权益必须保持 25,000 USD。');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(input.settings.startDate)&&finite(Date.parse(input.settings.startDate)),'统计起始日期无效。');
  assert(Array.isArray(input.rounds)&&input.rounds.length<=5000,'交易轮数据无效或过大。');
  assert(Array.isArray(input.snapshots)&&input.snapshots.length<=10000,'权益快照数据无效。');
  assert(Array.isArray(input.drawdownReviews)&&input.drawdownReviews.length<=1000,'回撤复核记录无效。');
  const ids=new Set(); const unique=id=>{assert(string(id,200)&&id.length>0&&!ids.has(id),'存在缺失或重复的数据 ID。');ids.add(id);};
  for(const r of input.rounds) {
    unique(r.id);assert(['active','history'].includes(r.scope),'交易分类无效。');
    assert(string(r.symbol,20)&&r.symbol.length>0&&(r.scope!=='active'||Object.hasOwn(SYMBOLS,r.symbol)),'主动交易只能记录 SOXL、AGQ、LABU、MSTU。');
    assert(['risk-on','neutral','risk-off'].includes(r.environment)&&['support','trend'].includes(r.strategy),'市场环境或入场策略无效。');
    assert(obj(r.plan)&&obj(r.checks)&&obj(r.review),'交易计划／检查／复盘信息缺失。');
    const p=calculatePlan(r.plan);
    if(r.scope==='active'||p.valid){assert(p.valid,'导入交易计划无效：'+p.errors.join(' '));assert(positive(r.initialRisk)&&Math.abs(r.initialRisk-p.risk)<EPS,'冻结的初始风险与原始计划不一致。');}
    else {assert(r.initialRisk===null&&positive(n(r.plan.entry))&&positive(n(r.plan.amount))&&(r.plan.stop===''||r.plan.stop===null),'历史计划缺少基础金额／价格，或未知初始风险被填为数值。');}
    assert(stamp(r.createdAt)&&string(r.title,300)&&string(r.entryReason)&&string(r.exitPlan)&&string(r.events),'交易轮时间或文本无效。');
    for(const [id] of CHECKS) assert(typeof r.checks[id]==='boolean','检查清单值必须为布尔值。');
    if(r.checkLabels!==undefined)assert(obj(r.checkLabels)&&CHECKS.every(([id])=>string(r.checkLabels[id],2000)),'冻结清单文本无效。');
    assert(typeof r.review.compliant==='boolean'||r.review.compliant===null,'规则遵守评价无效。');
    assert(string(r.review.notes)&&Number.isInteger(r.review.rating)&&r.review.rating>=0&&r.review.rating<=5,'复盘评价无效。');
    assert(Array.isArray(r.fills)&&r.fills.length<=10000&&Array.isArray(r.stopEvents),'成交／止损记录无效。');
    for(const f of r.fills) {
      unique(f.id);assert(stamp(f.at)&&['buy','sell'].includes(f.side)&&['entry','add','partial','exit'].includes(f.kind),'成交时间／类型无效。');
      assert(f.side==='buy'?['entry','add'].includes(f.kind):['partial','exit'].includes(f.kind),'买卖方向与成交类型不一致。');
      assert(Number.isInteger(f.qty)&&f.qty>0&&positive(f.price)&&finite(f.fee)&&f.fee>=0,'成交价格、股数或费用无效。');
      assert(f.plannedPrice===null||positive(f.plannedPrice),'计划成交价格无效。');
      assert(f.targetPrice===undefined||f.targetPrice===null||positive(f.targetPrice),'本笔目标价格无效。');
      assert(string(f.reason)&&['manual','target','stop','structure','other'].includes(f.reasonCode),'成交理由无效。');
      assert(Array.isArray(f.violations)&&f.violations.every(x=>string(x,2000))&&typeof f.trendConfirmed==='boolean','成交纪律记录无效。');
      assert(Number.isInteger(f.sequence)&&f.sequence>=0,'成交序号无效。');
    }
    let prior=Number(r.plan.stop), priorAt=-Infinity;
    for(const e of [...r.stopEvents].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
      unique(e.id);assert(stamp(e.at)&&positive(e.price)&&e.price+EPS>=prior&&string(e.reason)&&e.reason.trim().length>0,'止损调整不能下移，且须说明结构依据。');
      assert(Date.parse(e.at)>=priorAt,'止损调整时间无效。');prior=e.price;priorAt=Date.parse(e.at);
    }
    assert(r.mark===null||(obj(r.mark)&&positive(r.mark.price)&&stamp(r.mark.at)),'手动持仓估值无效。');
    accounting(r);
  }
  const times=new Set();
  for(const s of input.snapshots) {
    unique(s.id);assert(stamp(s.at)&&positive(s.equity)&&finite(s.flow)&&string(s.note),'权益快照无效。');
    assert(Date.parse(s.at)>=Date.parse(input.settings.startDate+'T00:00:00+08:00'),'权益快照早于统计起始日。');
    assert(!times.has(Date.parse(s.at)),'同一时刻存在重复权益快照。');times.add(Date.parse(s.at));
  }
  for(const r of input.drawdownReviews){unique(r.id);assert(stamp(r.at)&&string(r.notes)&&r.notes.trim().length>=10,'回撤复核结论至少需要 10 个字符。');}
  snapshotSeries(input);
  function validateDraft(d) {
    assert(obj(d)&&obj(d.plan)&&obj(d.checks),'计划草稿缺失。');
    assert(d.symbol===undefined||Object.hasOwn(SYMBOLS,d.symbol),'草稿标的无效。');
    assert(['neutral','risk-on','risk-off'].includes(d.environment)&&['support','trend'].includes(d.strategy),'草稿环境无效。');
    assert(string(d.reason)&&string(d.events),'草稿文本无效。');
    for(const key of ['equity','amount','entry','stop','targetR','targetPrice','costs','gapPct','scenarioPct'])assert(d.plan[key]===''||finite(Number(d.plan[key])),'草稿输入含非法数值。');
    assert(['r','price'].includes(d.plan.targetMode),'目标模式无效。');
  }
  validateDraft(input.draft);
  if(input.symbolDrafts!==undefined){
    assert(obj(input.symbolDrafts),'分标的草稿无效。');
    for(const [symbol,d] of Object.entries(input.symbolDrafts)){assert(Object.hasOwn(SYMBOLS,symbol)&&(d.symbol??'SOXL')===symbol,'分标的草稿与标的不一致。');validateDraft(d);}
  }
  assert(obj(input.meta)&&Number.isInteger(input.revision)&&input.revision>=0,'备份元数据无效。');
  return structuredClone(input);
}
export function newRound(state, {scope='active',symbol=state.draft.symbol??'SOXL',title=''}={}) {
  const d=state.draft, c=calculatePlan(d.plan);
  symbol=symbol.toUpperCase();
  if(scope==='active'&&!Object.hasOwn(SYMBOLS,symbol))throw Error('只支持 SOXL、AGQ、LABU、MSTU。');
  if(!c.valid && (scope==='active'||!positive(n(d.plan.entry))||!positive(n(d.plan.amount))||(d.plan.stop!==''&&d.plan.stop!==null))) throw Error(c.errors.join(' '));
  const combined=scope==='active'?calculateDraft(state):c;
  return {id:uid(),symbol,scope,title:title||`${symbol} · ${d.strategy==='support'?'支撑反弹':'上涨趋势'}`,createdAt:new Date().toISOString(),environment:d.environment,strategy:d.strategy,plan:structuredClone(d.plan),initialRisk:c.valid?c.risk:null,checks:Object.fromEntries(CHECKS.map(([k])=>[k,k==='risk'?c.valid&&c.risk<=c.budget+EPS&&(scope!=='active'||combined.portfolio.valid&&combined.combinedRisk<=c.budget+EPS):k==='reward'?c.valid&&c.netRR+EPS>=1.5:!!d.checks[k]])),checkLabels:Object.fromEntries(checksFor(symbol)),entryReason:d.reason,exitPlan:scope==='history'?'历史退出规则未补录；请根据原始记录保存，不猜测。':'默认测试：2R 实际减仓 50%；确认卖出后将剩余止损上移至实际成本均价，已有更高止损不下移；之后按 30 分钟结构继续上移。',events:d.events,fills:[],stopEvents:[],mark:null,review:{compliant:null,rating:0,notes:''}};
}
export function mergeStates(local, imported) {
  validateState(local);validateState(imported);
  assert(JSON.stringify(local.settings)===JSON.stringify(imported.settings),'账户设置冲突，请核对起始日；合并不会改写账户参数。');
  const result=structuredClone(local);
  for(const key of ['rounds','snapshots','drawdownReviews']) {
    const map=new Map(result[key].map(x=>[x.id,x]));
    for(const x of imported[key]) {
      if(map.has(x.id)&&JSON.stringify(map.get(x.id))!==JSON.stringify(x)) throw Error(`同一 ID 的 ${key} 内容冲突；未覆盖任何数据。请在主设备核对后使用明确的整库恢复。`);
      if(!map.has(x.id)){result[key].push(structuredClone(x));map.set(x.id,x);}
    }
  }
  return validateState(result);
}
const csvCell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
export function exportBackupCSV(state) {
  validateState(state);
  const rows=[['record_type','id','payload_json'],['settings','settings',JSON.stringify(state.settings)],['draft','draft',JSON.stringify(state.draft)],['meta','meta',JSON.stringify({schemaVersion:1,revision:state.revision,meta:state.meta})]];
  if(state.symbolDrafts!==undefined)rows.push(['symbolDrafts','symbolDrafts',JSON.stringify(state.symbolDrafts)]);
  for(const key of ['rounds','snapshots','drawdownReviews']) for(const row of state[key])rows.push([key,row.id,JSON.stringify(row)]);
  return '\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function parseCSV(text) {
  text=text.replace(/^\uFEFF/,'');
  let field='', row=[], rows=[], quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(!quoted&&field.length)throw Error('CSV 引号格式无效。');else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(field);field='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x!==''))rows.push(row);row=[];field='';}
    else field+=ch;
  }
  if(quoted)throw Error('CSV 引号未闭合。');
  if(field.length||row.length){row.push(field);rows.push(row);}return rows;
}
export function importBackupCSV(text) {
  const rows=parseCSV(text),head=rows.shift();
  assert(JSON.stringify(head)===JSON.stringify(['record_type','id','payload_json']),'这是备份 CSV 导入；请使用本网站导出的完整备份 CSV。券商任意 CSV 需先转换字段。');
  const state=defaultState(), singles=new Set();
  for(const row of rows){
    assert(row.length===3,'备份 CSV 列数错误。');const [kind,id,payload]=row;const data=JSON.parse(payload);
    if(['settings','draft','meta','symbolDrafts'].includes(kind)){
      assert(!singles.has(kind),'备份 CSV 重复元数据。');singles.add(kind);
      if(kind==='meta'){assert(data.schemaVersion===1,'不支持的 CSV 版本。');state.revision=data.revision;state.meta=data.meta;}else state[kind]=data;
    }else{assert(['rounds','snapshots','drawdownReviews'].includes(kind)&&data.id===id,'备份 CSV 类型或 ID 错误。');state[kind].push(data);}
  }
  assert(['settings','draft','meta'].every(key=>singles.has(key)),'备份 CSV 元数据不完整。');return validateState(state);
}
export function exportFillsCSV(state) {
  const rows=[['round_id','scope','symbol','time_iso','side','kind','quantity','actual_price_usd','planned_price_usd','fee_usd','realized_net_usd','remaining_qty','remaining_average_cost','initial_risk_usd','reason','violations']];
  const safeText=s=>/^[=+\-@\t\r]/.test(String(s))?"'"+s:s;
  for(const r of state.rounds)for(const f of accounting(r).rows)rows.push([r.id,r.scope,r.symbol,f.at,f.side,f.kind,f.qty,f.price,f.plannedPrice??'',f.fee,f.pnl,f.remaining,f.avg??'',r.initialRisk,safeText(f.reason),safeText(f.violations.join(' | '))]);
  return '\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
