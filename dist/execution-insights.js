// Read-only explanations and review views. Financial limits remain in discipline.js.
import {accounting,REVIEW_ERRORS,hasReviewBreach} from './core.js';
import {executionReview} from './risk.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const value=v=>v!==''&&v!=null&&Number.isFinite(Number(v))&&Number(v)>0;
const money=v=>v==null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(v);
const time=v=>stamp(v)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'未记录';
const rval=v=>v==null?'—':(v>=0?'+':'')+v.toFixed(2)+'R';

export function decisionChecks(r){
  const i=r.inputSnapshot,s=r.signal,at=r.evaluatedAt;
  const signalRecorded=stamp(i.signalAt),past=signalRecorded&&Date.parse(i.signalAt)<=Date.parse(at);
  const timeline=s.pass||!s.reasons.some(x=>/晚于|事前/.test(x));
  return [
    {id:'trend',label:'小时趋势',status:s.trend.known?(s.trend.pass?'pass':'wait'):'pending',detail:s.trend.reason},
    {id:'breakout',label:'30分钟突破价格',status:s.breakout===null?'pending':s.breakout?'pass':'wait',detail:s.breakout===null?'填写此前6根最高价与信号收盘价':s.breakout?'信号收盘价严格高于前6根最高价':'尚未形成收盘突破'},
    {id:'time',label:'信号收盘与有效时间',status:!signalRecorded||!past?'pending':s.fresh&&timeline?'pass':'wait',detail:!signalRecorded?'填写信号K线实际收盘时间':!past?'时间在未来，尚不能确认该信号':!timeline?'小时数据或快照晚于本笔，不能事后确认':s.fresh?'信号仍在下一根30分钟有效期内':'信号时间不合规则或已经过期'},
    {id:'window',label:'当前开仓时段',status:s.clock.entry?'pass':'wait',detail:s.clock.entry?'当前处于规则开仓窗口':s.clock.half?'半日交易日不开新仓':!s.clock.open?'当前休市，等待正常交易日':'等待10:30–15:30 ET，信号收盘须不晚于15:00'},
    {id:'portfolio',label:'账户与持仓资料',status:r.account.known&&r.portfolio.valid&&Number.isFinite(r.cash)&&r.cash>=0&&r.accountDayConfirmed?'pass':'pending',detail:!r.portfolio.valid?'补齐持仓估值与初始风险':!Number.isFinite(r.cash)?'可用现金尚未核对':!r.accountDayConfirmed?'核对该美东日开盘净值与可用现金':!r.account.known?'收盘净值与账户档位待核对':'资料已核对'},
    {id:'risk',label:'暂停与剩余额度',status:r.guard.blocked||r.account.known&&r.account.blocked?'wait':!r.account.known||!r.portfolio.valid||!r.limits.length?'pending':r.capacityQty>0?'pass':'wait',detail:r.guard.blocked?'连续亏损／违纪暂停仍有效':r.account.known&&r.account.blocked?'账户回撤暂停仍有效':r.capacityQty>0?`资金与风险最多允许${r.capacityQty}股`:'剩余额度不足或资料待核对'},
  ];
}

export function decisionExplanation(r){
  const info=(code,title,detail,focus='',action='')=>({code,title,detail,focus,action});
  if(r.ready)return info('ready',`允许新开 ${r.qty} 股`,'当前核对数据满足规则。实际成交后核对止损、目标与股数。');
  if(r.guard.blocked)return info('paused','暂停新开仓',r.guard.reasons[0]||'先完成规定休息与复盘。','discipline-portfolio','查看暂停条件');
  if(r.account.known&&r.account.blocked)return info('drawdown','账户回撤暂停',r.account.reasons[0]||'先完成账户恢复验收。','account-risk-summary','查看风险档位');
  if(!r.signal.clock.entry)return info('session','等待正常开仓时段',!r.signal.clock.open?'当前休市。价格仍可计算；下一正常交易日重新核对信号。':r.signal.clock.half?'半日交易日不开新仓。':'开仓窗口10:30–15:30 ET；对应信号须在10:30–15:00收盘。');
  if(!r.account.known)return info('account-data','账户风险资料待核对',r.account.reasons[0]||'先核对启用净值与最近收盘记录。','account-risk-summary','核对账户风险');
  if(!r.accountDayConfirmed||!Number.isFinite(r.cash))return info('cash-data','核对今日净值与现金','开仓前填写并确认该美东交易日的账户净值及可用现金。','discipline-equity','核对净值与现金');
  if(!r.levels.valid)return info('prices','先填写三项价格数据',r.levels.errors[0],'calc-symbol','填写价格参数');
  if(r.levels.tooWide)return info('distance','止损距离超过 3 倍 ATR','本笔放弃。等待新的完整信号，不通过临时缩紧止损来凑股数。','calc-symbol','核对价格参数');
  if(!r.signal.trend.known)return info('trend-data','小时数据待核对',r.signal.trend.reason+'；资料未知不等于趋势不合格。','signal-details','核对买点资料');
  if(!r.signal.trend.pass)return info('trend-off','小时趋势不合格','需同时满足小时收盘价 > EMA50，且 EMA20 > EMA50；等待新完成小时K线。','signal-details','查看趋势条件');
  if(r.signal.breakout===null)return info('breakout-data','30分钟突破资料待核对','填写前6根最高价、信号收盘价与实际收盘时间，价格计算不能代替买点确认。','signal-details','核对30分钟信号');
  if(!r.signal.breakout)return info('breakout','等待30分钟收盘突破','信号收盘价尚未严格高于此前6根最高价。','signal-details','查看突破门槛');
  if(!r.signal.pass)return info('signal-time','信号时间需要重新核对',r.signal.reasons[0]||'等待新的完整收盘信号。','signal-details','核对信号时间');
  if(!r.portfolio.valid)return info('positions-data','持仓估值或风险待补齐',r.portfolio.unknown.join('、')+'。未知数据不能按零处理。','discipline-portfolio','查看组合额度');
  if(r.portfolio.positions.some(x=>x.symbol===r.symbol))return info('position','该标的已有持仓','本版不重复加仓。继续管理已有交易的退出。','open-positions','查看当前持仓');
  if(r.portfolio.positions.length>=3)return info('slots','已有三笔持仓','先按规则退出，再等待新的完整买点。','open-positions','查看当前持仓');
  if(r.capacityQty===0){
    const limits=r.limits.filter(x=>Math.floor(x.qty+1e-8)<1).map(x=>x.name);
    return info('capacity','剩余额度不足 1 股',`${limits.join('、')||'资金与风险'}限制本次新开；浮盈不释放初始风险占用。`,'discipline-portfolio','查看额度明细');
  }
  return info('quantity','核对本次拟买股数',`请填写1至${r.capacityQty}之间的整股数，或留空采用允许上限。`,'signal-details','核对计算输入');
}

export function captureEntryCheck(r){
  return {version:1,at:r.evaluatedAt,ready:r.ready,allowedQty:r.ready?r.qty:0,source:r.inputSnapshot.trendOrigin==='auto'?'auto':'manual',hourAt:stamp(r.inputSnapshot.hourAt)?r.inputSnapshot.hourAt:null,signalAt:stamp(r.inputSnapshot.signalAt)?r.inputSnapshot.signalAt:null,checks:decisionChecks(r).map(({id,status})=>({id,status})),reasons:[...r.reasons]};
}

export function errorTags(round){
  const tags=[...(round.review.errorHistory??[]).map(x=>x.tag),round.review.errorTag].filter(x=>x&&x!=='none');
  return [...new Set(tags)];
}
export function matchesError(round,filter='all'){
  if(filter==='all')return true;
  if(filter==='untagged')return !round.review.errorTag&&!errorTags(round).length;
  if(filter==='none')return round.review.errorTag==='none'&&!errorTags(round).length;
  return errorTags(round).includes(filter);
}
export function errorOptions(selected='all',{review=false}={}){
  const entries=review?[['','尚未标注'],...Object.entries(REVIEW_ERRORS)]:[['all','全部标签'],['untagged','尚未标注'],...Object.entries(REVIEW_ERRORS)];
  return entries.map(([key,label])=>`<option value="${key}"${key===selected?' selected':''}>${esc(label)}</option>`).join('');
}
export function saveReview(round,input,now=new Date().toISOString()){
  const tag=input.errorTag??round.review.errorTag??'';
  if(tag&&!Object.hasOwn(REVIEW_ERRORS,tag))throw Error('复盘错误标签无效。');
  const previous=round.review,history=structuredClone(previous.errorHistory??[]);
  if(previous.errorTag&&previous.errorTag!=='none'&&!history.some(x=>x.tag===previous.errorTag))history.push({at:previous.reviewedAt??now,tag:previous.errorTag});
  if(tag&&tag!=='none'&&!history.some(x=>x.tag===tag))history.push({at:now,tag});
  const confirmed=input.compliant==='no'||previous.compliant===false||round.fills.some(f=>f.violations.length)||history.length>0||hasReviewBreach({errorTag:tag});
  round.review={...previous,compliant:confirmed?false:input.compliant==='unknown'?null:input.compliant==='yes',rating:Number(input.rating),notes:input.notes??'',reviewedAt:now,errorTag:tag,errorHistory:history};
  if(confirmed)round.review.breachAt=previous.breachAt??(previous.compliant===false?previous.reviewedAt:null)??history[0]?.at??now;
  return round.review;
}

export function reviewDiagnostics(rounds){
  const rows=rounds.filter(r=>r.scope==='active').map(round=>({round,a:accounting(round)})).filter(x=>x.a.closed);
  const sum=list=>({count:list.length,avgR:list.length?list.reduce((n,x)=>n+x.a.r,0)/list.length:null});
  const groups={all:sum(rows),compliant:sum(rows.filter(x=>executionReview(x.round)==='compliant')),breach:sum(rows.filter(x=>executionReview(x.round)==='breach')),pending:sum(rows.filter(x=>executionReview(x.round)==='pending'))};
  const errors={};let untagged=0;
  for(const {round} of rows){if(matchesError(round,'untagged'))untagged++;for(const tag of errorTags(round))errors[tag]=(errors[tag]??0)+1;}
  return {groups,errors,untagged};
}
export function diagnosticsHTML(rounds){
  const {groups,errors,untagged}=reviewDiagnostics(rounds),labels={all:'全部实盘',compliant:'守纪子集',breach:'已确认违纪',pending:'资料／评价待核对'};
  return `<div class="execution-diagnostic-grid">${Object.entries(groups).map(([key,v])=>`<div><span>${labels[key]}</span><strong>${rval(v.avgR)}</strong><small>${v.count}笔 · 平均实际R</small></div>`).join('')}</div><p class="field-note">以上使用当前标的与版本的完整退出记录。守纪子集未覆盖漏做信号，不能替代策略回测。</p><div class="review-error-counts">${Object.entries(errors).sort((a,b)=>b[1]-a[1]).map(([key,n])=>`<span>${esc(REVIEW_ERRORS[key])} <strong>${n}笔</strong></span>`).join('')||'<span>尚无已标注的执行错误</span>'}<span>尚未标注 ${untagged}笔</span></div><p class="field-note">标签用于定位行为，不改写成交和盈亏。一笔可保留多个已确认偏离标签。</p>`;
}
export function entryAuditHTML(round){
  const model=round.executionModel;if(model?.mode!=='atr-2r')return '';
  const i=model.inputSnapshot??{},check=i.entryCheck,entry=round.fills.find(f=>f.side==='buy'),early=check&&stamp(check.at)&&Date.parse(check.at)<=Date.parse(entry?.at??round.createdAt);
  const label=!check?'未留核对时间':!early?'核对晚于成交':check.ready?'入场前计算通过':'核对时仍有待办';
  const pairs=[['规则版本',model.ruleVersion??'旧结构版本'],['数据来源',i.trendOrigin==='auto'?'策略台自动小时快照':'手动核对'],['核对时间（中国）',check?time(check.at):'未记录，不推定事前已核对'],['小时K线收盘',time(i.hourAt)],['30分钟信号收盘',time(i.signalAt)],['小时收盘／EMA20／EMA50',[i.close1h,i.ema20,i.ema50].map(x=>value(x)?money(Number(x)):'未记录').join(' / ')],['冻结ATR／结构低点',money(model.atr)+' / '+money(model.low)],['前6根最高／信号收盘',[i.high,i.close30].map(x=>value(x)?money(Number(x)):'未记录').join(' / ')],['当时买入参考价',money(model.plannedEntry)],['入场前允许股数',check?(check.ready?check.allowedQty+'股':'0股 · 当时未满足'):'未记录']];
  const flags=check?.reasons??[];
  return `<details class="compact-details entry-audit"><summary>入场快照 · ${esc(label)}</summary><dl class="entry-audit-grid">${pairs.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${flags.length?`<p class="field-note">当时待办：${flags.map(esc).join('；')}</p>`:''}<p class="field-note">行情与核对时间随本笔保存，之后同步不改写。计算通过与实际成交是否守纪分别核对；未留时间的旧记录不补造事前证据。</p></details>`;
}
export function initialRiskHTML(round){
  if(round.executionModel?.mode!=='atr-2r')return '';
  return `<span>本笔初始1R <strong>${money(round.initialRisk)}</strong></span><small class="position-rule">+1R不操作 · 保护订单在券商核对</small>`;
}
