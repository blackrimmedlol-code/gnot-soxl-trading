import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultState,newRound,prepareQuickBuy,prepareQuickFill,accounting,validateState,statistics,breakevenStop,exportBackupCSV,importBackupCSV,tradingGuard} from '../dist/core.js';
const now='2026-11-05T15:00:00Z';
const buy=(symbol='SOXL',extra={})=>({symbol,qty:100,price:50,stop:48,at:now,reason:'已发生的支撑反弹买入',...extra});
function saveBuy(s,input=buy()){const result=prepareQuickBuy(s,input,now);if(result.isNew)s.rounds.push(result.round);else s.rounds=s.rounds.map(r=>r.id===result.round.id?result.round:r);return result;}
function planned(){const s=defaultState();s.draft.plan={...s.draft.plan,entry:50,stop:48};s.draft.reason='事前技术支撑';s.draft.events='已评估隔夜风险';s.draft.checks={market:true,soxx:true,support:true,signal:true,stop:true,event:true,emotion:true};const r=newRound(s);r.createdAt='2026-11-05T14:00:00Z';r.entrySource='plan';s.rounds.push(r);return {s,r};}
function sell(s,id,qty,price,extra={}){const p=prepareQuickFill(s,id,{side:'sell',qty,price,at:'2026-11-05T15:01:00Z',reason:'实际减仓',...extra},'2026-11-05T15:02:00Z');s.rounds=s.rounds.map(r=>r.id===id?p.round:r);return p;}

test('四标的一次买入同时生成交易轮及实际成交，不改写原状态',()=>{
  for(const symbol of ['SOXL','AGQ','LABU','MSTU']){
    const s=defaultState(),original=structuredClone(s),p=prepareQuickBuy(s,buy(symbol),now);
    assert.equal(p.isNew,true);assert.equal(p.round.fills.length,1);assert.equal(p.round.symbol,symbol);
    assert.equal(accounting(p.round).qty,100);assert.equal(p.round.initialRisk,200);assert.equal(p.check.pass,true);
    assert.deepEqual(s,original);validateState({...s,rounds:[p.round]});
  }
});
test('补录不会自动勾选事前清单，也不会自动增加合规率',()=>{
  const s=defaultState();s.draft.checks={market:true,soxx:true,support:true,signal:true,stop:true,event:true,emotion:true};
  const p=saveBuy(s);assert.equal(p.round.entrySource,'actual');assert.equal(p.round.checks.market,false);assert.equal(p.round.review.compliant,null);
  sell(s,p.round.id,100,51);assert.equal(statistics(s).compliance,null);assert.equal(statistics(s).reviewCount,0);
});
test('快捷确认沿用已有计划、理由和冻结 R，实际价差不改写原计划',()=>{
  const {s,r}=planned(),oldPlan=structuredClone(r.plan),oldChecks=structuredClone(r.checks);
  const p=prepareQuickBuy(s,buy('SOXL',{planId:r.id,qty:99,price:50.05,reason:''}),now);
  assert.equal(p.isNew,false);assert.equal(p.round.id,r.id);assert.deepEqual(p.round.plan,oldPlan);assert.deepEqual(p.round.checks,oldChecks);
  assert.equal(p.round.initialRisk,200);assert.equal(p.fill.price,50.05);assert.equal(p.fill.reason,'事前技术支撑');
});
test('同一计划不能重复确认，不能将更早成交追溯关联至后来计划',()=>{
  const {s,r}=planned();assert.throws(()=>prepareQuickBuy(s,buy('SOXL',{planId:r.id,at:'2026-11-05T13:00:00Z'}),now),/成交早于/);
  saveBuy(s,buy('SOXL',{planId:r.id}));assert.throws(()=>prepareQuickBuy(s,buy('SOXL',{planId:r.id}),now),/已登记成交/);
});
test('已有持仓不另开重复交易轮；加仓保留初始风险并核对盈利与趋势',()=>{
  const s=defaultState(),p=saveBuy(s);assert.throws(()=>prepareQuickBuy(s,buy(),now),/已有持仓/);
  const add=prepareQuickFill(s,p.round.id,{...buy(),side:'buy',qty:10,price:51,trendConfirmed:false},now);
  assert.equal(add.fill.kind,'add');assert.equal(add.round.initialRisk,200);assert.match(add.check.violations.join(' '),/趋势/);
});
test('半仓 2R 实际止盈加剩余退出，金额及 R 不重复计算',()=>{
  const s=defaultState(),p=saveBuy(s),half=sell(s,p.round.id,50,54,{reasonCode:'target'});
  assert.equal(half.fill.kind,'partial');assert.equal(half.check.after.qty,50);assert.equal(half.check.after.realized,200);assert.equal(half.check.after.r,1);
  assert.equal(breakevenStop(half.round).price,50);
  const all=sell(s,p.round.id,50,52);assert.equal(all.fill.kind,'exit');assert.equal(all.check.after.realized,300);assert.equal(all.check.after.r,1.5);
  assert.equal(statistics(s).total,1);assert.equal(statistics(s).realized,300);validateState(s);
});
test('奇数半仓向下取整，超卖与已清仓追加成交拒绝',()=>{
  const s=defaultState(),p=saveBuy(s,buy('SOXL',{qty:101}));sell(s,p.round.id,50,54);
  assert.equal(accounting(s.rounds[0]).qty,51);
  assert.throws(()=>sell(s,p.round.id,52,51),/超过/);sell(s,p.round.id,51,51);
  assert.throws(()=>sell(s,p.round.id,1,51),/已退出/);
});
test('快速买入仍保存超 1% 风险违规，不扩预算或缩股',()=>{
  const p=prepareQuickBuy(defaultState(),buy('SOXL',{qty:200}),now);
  assert.equal(p.round.plan.quantity,200);assert.equal(p.round.plan.stop,48);assert.equal(p.check.pass,false);
  assert.match(p.fill.violations.join(' '),/1%/);assert.equal(p.round.review.compliant,false);
});
test('合计风险、Risk-off 及连续两轮止损纪律仍适用于快速记录',()=>{
  const s=defaultState();saveBuy(s);const second=prepareQuickBuy(s,buy('AGQ',{qty:100,stop:49}),now);
  assert.match(second.fill.violations.join(' '),/合计.*1%/);
  const off=defaultState();off.draft.environment='risk-off';assert.match(prepareQuickBuy(off,buy(),now).fill.violations.join(' '),/Risk-off/);
  const stopped=defaultState();for(let i=0;i<2;i++){const b=saveBuy(stopped,buy('SOXL',{at:'2026-11-05T14:00:00Z'}));sell(stopped,b.round.id,100,48,{reasonCode:'stop'});}
  assert.equal(tradingGuard(stopped,'2026-11-05T15:02:00Z').blocked,true);
});
test('无效价格、数量、止损、时间和空理由不能产生半条保存记录',()=>{
  const s=defaultState(),old=structuredClone(s);
  for(const extra of [{qty:0},{qty:1.5},{price:0},{stop:51},{at:'2026-11-06T15:00:00Z'},{reason:''}])assert.throws(()=>prepareQuickBuy(s,buy('SOXL',extra),now));
  assert.deepEqual(s,old);
});
test('新记录来源与快捷成交可完整导出恢复，旧记录保持原样',()=>{
  const {s,r}=planned(),legacy=structuredClone(r);delete r.entrySource;
  const before=structuredClone(r);saveBuy(s,buy('AGQ',{qty:20,stop:49}));
  const restored=importBackupCSV(exportBackupCSV(s));assert.deepEqual(restored,s);assert.deepEqual(restored.rounds[0],before);
  assert.equal(restored.rounds[1].entrySource,'actual');assert.equal(legacy.initialRisk,restored.rounds[0].initialRisk);
});
