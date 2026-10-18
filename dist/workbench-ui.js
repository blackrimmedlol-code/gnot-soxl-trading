import {trendMode,trendSnapshot,effectiveMarketInput} from './trend-feed.js';
import {riskSummary} from './risk-ui.js';
import {WATCHLIST,ensureWorkbench,calculateWorkbench,trendState,marketClock,disciplineGuard} from './discipline.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>v===null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v);
const price=v=>v===null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(v);
const cn=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)).replace(' ','T');
const field=(name,label,placeholder,help='')=>`<label>${label}<input data-market="${name}" type="number" min="0.00000001" step="any" inputmode="decimal" placeholder="${placeholder}">${help?`<small>${help}</small>`:''}</label>`;
const timeField=(name,label)=>`<label>${label}<input data-market="${name}" type="datetime-local"><small>中国时间，填写该根K线的实际收盘时间</small></label>`;
export function mountWorkbench({getState,onEdit,onUse,onRecovery}){
  const root=document.querySelector('#workbench-root');
  root.innerHTML=`<div id="account-risk-summary"></div><section class="discipline-account"><label>当日开盘账户净值 USD<input id="discipline-equity" type="number" min="1" step="0.01" inputmode="decimal"></label><label>当前可用现金 USD<input id="discipline-cash" type="number" min="0" step="0.01" inputmode="decimal" placeholder="按账户实际值填写"></label><div class="account-budget"><span>单笔计划风险</span><strong id="single-budget">—</strong><small>按风险档位 · 额度为上限</small></div><div class="account-budget"><span>三只合计计划风险</span><strong id="total-budget">—</strong><small>三只共享 · 不因浮盈释放</small></div><button type="button" id="confirm-equity-day" class="quiet-button">确认今日净值与现金</button><span id="equity-day-status" class="field-note"></span></section>
  <div class="trend-sync-toolbar"><label>小时数据来源<select id="trend-source-mode"><option value="auto">策略台自动快照</option><option value="manual">手动核对</option></select></label><div id="trend-feed-status" class="trend-feed-status"></div><button type="button" id="refresh-trend-feed" class="quiet-button">同步最新快照</button></div><div id="battlefield-cards" class="battlefield-cards" aria-label="固定三个战场"></div>
  <div class="decision-grid"><section class="panel market-inputs"><div class="section-title"><div><span class="micro">01 / THREE INPUTS</span><h2>先算价格和股数</h2></div><span class="tag" id="calc-symbol">SOXL</span></div><p class="input-intro">填写买入参考价与结构低点，ATR可由自动小时快照填入。买点条件在下方展开核对。</p><div class="field-grid">${field('entry','买入参考价 P₀','你准备买入的限价')}${field('atr','1小时 ATR(14)','已收盘小时波动值','Wilder平滑，不填波动百分比')}${field('low','近6根30分钟最低价 L','包含信号K线','与前6根最高价的取数范围不同')}${field('requestedQty','本次拟买股数（可留空）','留空按允许上限','可主动减少股数，止损与目标不变')}</div>
  <details class="compact-details" id="signal-details"><summary>核对买点与数据时间 <span id="signal-summary">待核对</span></summary><div class="field-grid">${field('close1h','已收盘1小时收盘价','小时收盘价')}${field('ema20','1小时 EMA20','小时EMA20')}${field('ema50','1小时 EMA50','小时EMA50')}${timeField('hourAt','1小时K线收盘时间')}${field('high','此前6根30分钟最高价','不包含信号K线')}${field('close30','信号30分钟收盘价','刚收盘的30分钟K线')}${timeField('signalAt','30分钟信号收盘时间')}</div><p class="field-note">仅正常交易时段的已收盘K线。信号收盘后仅下一根30分钟有效；开仓信号时间10:30–15:00 ET。</p></details>
  <details class="compact-details"><summary>更新当前手动价格 · 核对持仓卖点</summary><div class="field-grid">${field('current','当前可成交参考价','按行情手动填写')}${timeField('currentAt','该报价时间')}</div><p class="field-note">报价5分钟内有效，用于组合估值与持仓卖点；不替代券商止损订单。成交记录保存后须重新核对可用现金。</p></details><p class="input-source"><span class="source-dot"></span>小时趋势可自动同步 · 30分钟信号及报价手动核对</p></section>
  <section class="panel decision-output" aria-live="polite"><div class="section-title"><div><span class="micro">02 / DECISION & LEVELS</span><h2>买卖点计算结果</h2></div><span id="decision-badge" class="decision-badge">等待输入</span></div><div id="decision-levels"></div><div id="decision-size"></div><div id="decision-checks"></div><div id="decision-reasons"></div><button type="button" id="use-calculation" class="primary-button full-width">带入实际买入记录 →</button><p class="field-note">带入不代表成交，实际发生后再保存。当前参考参数未经回测验证。</p></section></div>
  <div id="discipline-portfolio" class="portfolio-budget-panel"></div>`;
  let selected='SOXL',current=null;
  root.addEventListener('input',e=>{
    const state=getState();if(!state)return;const w=ensureWorkbench(state),el=e.target;
    if(el.matches('[data-market]')){
      const key=el.dataset.market;w.inputs[selected]??={};
      if(['signalAt','hourAt','currentAt'].includes(key)){const at=el.value?new Date(el.value+'+08:00'):null;w.inputs[selected][key]=at&&Number.isFinite(at.getTime())?at.toISOString():'';}
      else w.inputs[selected][key]=el.value;
    }else if(el.id==='discipline-equity'){if(Number(el.value)<=0||!el.value)return;w.equity=Number(el.value);document.querySelector('#buy-form').elements.equity.value=el.value;}
    else if(el.id==='discipline-cash'){if(el.value!==''&&Number(el.value)<0)return;w.cash=el.value;}
    else return;
    const d=w.inputs[selected];
    if(d&&Number(d.current)>0&&Number.isFinite(Date.parse(d.currentAt))&&Date.parse(d.currentAt)<=Date.now())for(const r of state.rounds)if(r.symbol===selected&&r.fills.some(f=>f.side==='buy'))r.mark={price:Number(d.current),at:d.currentAt};
    onEdit();render(selected);
  });
  root.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='use-calculation'&&current?.levels.valid)onUse(current);if(b.id==='discipline-recovery')onRecovery();});
  function render(symbol='SOXL'){
    const state=getState();if(!state)return;const w=ensureWorkbench(state);selected=WATCHLIST.includes(symbol)?symbol:'SOXL';
    const now=new Date().toISOString(),input=effectiveMarketInput(state,selected,now),source=trendSnapshot(state,selected,now);current=calculateWorkbench(state,selected,input,now);
    root.querySelector('#trend-source-mode').value=trendMode(state,selected);
    const format=at=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));
    root.querySelector('#trend-feed-status').innerHTML=`<strong>${esc(source.label)}</strong>${source.row?`<span>Yahoo正式盘1小时 · K线收盘 ${esc(format(source.row.barCloseAt))} · ATR ${Number(source.row.atr14).toFixed(4)}</span>`:''}<small>自动任务每日四次；30分钟突破仍须现场核对。${w.trendFetchError?'同步失败，未刷新旧快照：'+esc(w.trendFetchError):''}</small>`;
    for(const [id,value]of [['discipline-equity',w.equity],['discipline-cash',w.cash]]){const el=root.querySelector('#'+id);if(el!==document.activeElement)el.value=value;}
    root.querySelectorAll('[data-market]').forEach(el=>{const autoField=['atr','close1h','ema20','ema50','hourAt'].includes(el.dataset.market);el.readOnly=source.mode==='auto'&&(autoField&&!!source.row||autoField&&el.dataset.market!=='atr');if(el===document.activeElement)return;const v=input[el.dataset.market];el.value=v&&['signalAt','hourAt','currentAt'].includes(el.dataset.market)?cn(v):v??'';});
    root.querySelector('#account-risk-summary').innerHTML=riskSummary(state,now);root.querySelector('#equity-day-status').textContent=w.equityDay===current.signal.clock.day?'已确认 '+w.equityDay+' 美东日净值；现金变化后重填':'开仓前确认当日净值与现金';
    root.querySelector('#single-budget').textContent=money(current.singleBudget);root.querySelector('#total-budget').textContent=money(current.totalBudget);root.querySelector('#calc-symbol').textContent=selected;
    root.querySelector('#battlefield-cards').innerHTML=WATCHLIST.map(s=>{
      const data=effectiveMarketInput(state,s,now),snapshot=trendSnapshot(state,s,now),t=trendState(data,now),result=calculateWorkbench(state,s,data,now),description={SOXL:'半导体 · 3×',GDXU:'金矿股 · 3× ETN',BITX:'比特币期货 · 2×'}[s];
      return `<button type="button" data-symbol="${s}" class="battlefield-card ${s===selected?'selected':''}" aria-pressed="${s===selected}"><span class="battlefield-top"><strong>${s}</strong><span class="status-dot ${result.ready?'ready':t.known&&!t.pass?'off':''}"></span></span><span>${description}</span><small>${result.ready?'满足当前开仓条件':t.known?t.pass?'趋势合格 · 等突破核对':'趋势不合格 · 不开仓':snapshot.mode==='auto'?snapshot.status==='unavailable'?'自动数据未取得':snapshot.status==='stale'?'自动快照已过期':'休市参考 · 开盘后核对':'趋势待核对'}</small></button>`;
    }).join('');
    const l=current.levels;
    root.querySelector('#decision-badge').textContent=!l.valid?'等待输入':current.ready?'条件满足':'仅计算 · 待条件';root.querySelector('#decision-badge').classList.toggle('ready',current.ready);
    root.querySelector('#decision-levels').innerHTML=l.valid?`<div class="breakout-level"><span>收盘突破门槛</span><strong>${Number(input.high)>0?'30分钟收盘 > '+price(Number(input.high)):'展开买点核对后显示'}</strong></div><div class="level-pair"><div class="stop-level"><span>初始止损 −1R</span><strong id="calculated-stop">${price(l.stop)}</strong><small>距参考买价 −${(l.stopPct*100).toFixed(2)}%</small></div><div class="target-level"><span>全额止盈 +2R</span><strong id="calculated-target">${price(l.target)}</strong><small>距参考买价 +${(l.targetPct*100).toFixed(2)}%</small></div></div><svg class="price-ladder" viewBox="0 0 480 75" role="img" aria-label="初始止损${l.stop}，买入参考${l.entry}，两倍风险目标${l.target}"><line x1="24" y1="16" x2="456" y2="16" stroke="var(--line)" stroke-width="3"/><line x1="24" y1="16" x2="168" y2="16" stroke="var(--red)" stroke-width="3"/><line x1="168" y1="16" x2="456" y2="16" stroke="var(--accent)" stroke-width="3"/>${[[24,'止损'],[168,'参考买价'],[456,'+2R']].map(([x,name])=>`<circle cx="${x}" cy="16" r="5" fill="${x===24?'var(--red)':'var(--accent)'}"/><text x="${x}" y="42" text-anchor="${x===24?'start':x===456?'end':'middle'}" fill="var(--muted)" font-size="11">${name}</text>`).join('')}<text x="168" y="64" text-anchor="middle" fill="var(--text)" font-size="14">${esc(price(l.entry))}</text></svg><p class="calculation-basis">${esc(l.rule)} · 止损距离 ${l.atrMultiple.toFixed(2)} × ATR${l.tooWide?' · 超过3倍，放弃':''}</p>`:`<div class="calculation-empty"><span>— / —</span><p>填入左侧三项，计算初始止损与 +2R。</p></div>`;
    root.querySelector('#decision-size').innerHTML=`<div class="sizing-main"><div><span>单笔参考股数</span><strong id="reference-quantity">${current.referenceQty??'—'}<small> 股</small></strong></div><div><span>本次允许新开</span><strong id="allowed-quantity" class="${current.ready?'positive':''}">${current.ready?current.qty:0}<small> 股</small></strong></div></div><p class="sizing-constraint">资金与风险允许上限 <strong>${current.capacityQty} 股</strong> · 限制项：${esc(current.limiting)}</p><div class="size-foot"><span>单笔参考风险 <strong>${l.valid&&current.referenceQty!==null?money(current.referenceQty*l.distance):'—'}</strong></span><span>参考投入 <strong>${l.valid&&current.referenceQty!==null?money(current.referenceQty*l.entry):'—'}</strong></span></div><p class="field-note">参考股数仅按当前档位单笔风险和25%市值上限计算。完整核对后才能新开；提高风险预算不改变止损距离。</p>`;
    const checks=[['小时趋势',current.signal.trend.known?current.signal.trend.pass:null],['30分钟突破',current.signal.breakout],['信号时间有效',current.signal.fresh&&current.signal.clock.entry],['组合数据齐全',current.portfolio.valid&&Number.isFinite(current.cash)],['账户风险与暂停',current.account.known?!current.guard.blocked&&!current.account.blocked:null]];
    root.querySelector('#decision-checks').innerHTML='<div class="decision-check-list">'+checks.map(([name,pass])=>`<div><span>${name}</span><strong class="${pass===true?'check-pass':pass===false?'check-wait':''}">${pass===true?'通过':pass===null?'待核对':'未通过'}</strong></div>`).join('')+'</div>';
    root.querySelector('#signal-summary').textContent=current.signal.pass?'已满足':'待核对 / 未满足';
    root.querySelector('#decision-reasons').innerHTML=current.reasons.length?'<ul class="decision-reasons">'+current.reasons.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>':'<p class="ready-note">当前数据满足条件；按限价和股数核对券商订单。</p>';
    root.querySelector('#use-calculation').disabled=!l.valid||l.tooWide||current.referenceQty===0;
    const portfolio=current.portfolio;
    root.querySelector('#discipline-portfolio').innerHTML=`<div class="budget-title"><div><span class="micro">PORTFOLIO / SHARED LIMITS</span><h2>组合额度</h2></div><span class="tag">已核对合格 ${current.qualified}/3 · 待核对 ${current.unknown}</span></div><div class="portfolio-metrics"><div><span>当前趋势仓位上限</span><strong>${Math.round(current.cap*100)}%</strong><small>${money(current.equity*current.cap)}</small></div><div><span>持仓市值 / 上限</span><strong>${portfolio.valid?money(portfolio.value):'待更新估值'}</strong><small>单只不超过25%</small></div><div><span>已占用计划风险</span><strong>${portfolio.valid?money(portfolio.risk):'待核对'}</strong><small>剩余 ${portfolio.valid?money(Math.max(0,current.totalBudget-portfolio.risk)):'待核对'} / 上限 ${money(current.totalBudget)}</small></div><div><span>持仓数量</span><strong>${portfolio.positions.length} / 3</strong><small>同一标的不重复加仓</small></div></div>${portfolio.unknown.length?'<p class="budget-warning">请补齐 '+esc(portfolio.unknown.join('、'))+'。已有仓位数据未知时暂停新增。</p>':''}${current.guard.blocked?`<div class="budget-warning">${esc(current.guard.reasons.join(' '))} <button type="button" id="discipline-recovery" class="quiet-button">记录恢复复盘</button></div>`:''}<p class="field-note">自动快照及手动核对共同计算；过期数据不放行新增。总市值上限0 / 25% / 50% / 60%；总风险额度不因浮盈释放。</p>`;
  }
  return {render,getCurrent:()=>current};
}

export function positionDecision(round,input={},now=new Date().toISOString()){
  const clock=marketClock(now),p=Number(input.current),age=Date.parse(now)-Date.parse(input.currentAt),fresh=Number.isFinite(p)&&p>0&&Number.isFinite(age)&&age>=0&&age<5*60000;
  const stop=Number(round.plan.stop),target=Number(round.plan.entry)+2*(Number(round.plan.entry)-stop),trend=trendState(input,now);
  if(fresh&&p<=stop)return {urgent:true,text:'手动报价已触及止损 · 执行退出'};
  if(fresh&&p>=target)return {urgent:true,text:'手动报价已达+2R · 全额退出'};
  if(trend.known&&!trend.pass)return {urgent:true,text:'小时趋势失效 · 下一根30分钟退出'};
  if(clock.exitDue)return {urgent:true,text:'休市前退出时间已到 · 退出剩余持仓'};
  if(!fresh)return {urgent:false,text:'当前报价未更新，暂不判断价格卖点'};
  return {urgent:false,text:'手动报价未触及两档价位 · +1R不自动保本'};
}
