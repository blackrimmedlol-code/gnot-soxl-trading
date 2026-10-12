import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_PROFILES,executionPrices,defaultState,prepareExecutionBuy,prepareExecutionFill,accounting,portfolioRisk,validateState,statistics,newRound,exportBackupCSV,importBackupCSV,tradingGuard} from '../dist/core.js';
const now='2026-11-05T15:00:00Z',later='2026-11-05T15:01:00Z';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const input=(symbol='SOXL',extra={})=>({symbol,qty:50,price:100,at:now,reason:'执行记录验收',...extra});
function buy(s,i=input()){const p=prepareExecutionBuy(s,i,now);s.rounds.push(p.round);return p;}
function exit(s,id,price,extra={}){const r=s.rounds.find(r=>r.id===id),p=prepareExecutionFill(s,id,{side:'sell',qty:accounting(r).qty,price,at:later,reason:'实际退出',reasonCode:'target',...extra},later);s.rounds=s.rounds.map(r=>r.id===id?p.round:r);return p;}

for(const [symbol,stop,target,risk] of [['SOXL',97.85,104.30,107.5],['AGQ',98.8,102.4,60],['LABU',97.45,105.1,127.5],['MSTU',96.7,106.6,165]]){
  test(`${symbol} 输入买入价自动计算已确认参考比例和初始 R`,()=>{
    const x=executionPrices(symbol,100);near(x.stop,stop);near(x.target,target);
    const s=defaultState(),p=buy(s,input(symbol));near(p.round.initialRisk,risk);assert.equal(p.check.pass,true);
    assert.equal(p.round.executionModel.stopPct,EXECUTION_PROFILES[symbol].stopPct);validateState(s);
  });
  test(`${symbol} 固定止损为 −1R，全额目标退出为 +2R`,()=>{
    let s=defaultState(),b=buy(s,input(symbol)),p=exit(s,b.round.id,target);near(p.check.after.r,2);assert.equal(p.check.after.qty,0);assert.equal(p.check.pass,true);
    s=defaultState();b=buy(s,input(symbol));p=exit(s,b.round.id,stop,{reasonCode:'stop'});near(p.check.after.r,-1);assert.equal(p.check.pass,true);
  });
}
test('只输入价格即可计算参考，零、空白、负值和未知标的不计算',()=>{
  assert.ok(executionPrices('SOXL',50));for(const p of ['',null,0,-1,Infinity])assert.equal(executionPrices('SOXL',p),null);
  assert.equal(executionPrices('RAM',100),null);near(executionPrices('SOXL',50).stop,48.925);near(executionPrices('SOXL',50).target,52.15);
});
test('同标的右侧买入独立建轮，账户共同预算仍累计检查',()=>{
  const s=defaultState(),a=buy(s,input('SOXL',{qty:50})),b=buy(s,input('SOXL',{qty:50,price:101}));
  assert.notEqual(a.round.id,b.round.id);assert.equal(a.round.fills.length,1);assert.equal(b.round.fills.length,1);assert.equal(b.check.pass,true);
  near(a.round.initialRisk,107.5);near(b.round.initialRisk,108.575);near(portfolioRisk(s).risk,216.075);
  const c=prepareExecutionBuy(s,input('AGQ',{qty:50}),now);assert.equal(c.check.pass,false);assert.match(c.fill.violations.join(' '),/合计/);
  assert.throws(()=>prepareExecutionFill(s,a.round.id,{side:'buy',qty:1,price:110,at:later,reason:'再买'},later),/独立/);
});
test('+1R 不自动产生止损调整或卖出记录，部分止盈如实统计但标明偏离',()=>{
  const s=defaultState(),b=buy(s),r=b.round,oneR=100+(100-r.plan.stop);
  r.mark={price:oneR,at:later};assert.equal(r.stopEvents.length,0);assert.equal(r.fills.length,1);near(r.plan.stop,97.85);
  const p=exit(s,r.id,104.3,{qty:25});near(p.check.after.r,1);assert.equal(p.check.after.qty,25);assert.equal(p.check.pass,false);assert.match(p.fill.violations.join(' '),/部分卖出/);
});
test('实际跳空退出按真实成交价计算，损失可以超过参考 −1R',()=>{
  const s=defaultState(),b=buy(s),p=exit(s,b.round.id,95,{reasonCode:'stop'});near(p.check.after.realized,-250);near(p.check.after.r,-250/107.5);
});
test('新规则首次买入更正同步参考价及 R，已保存参数仍用本笔快照',()=>{
  const s=defaultState(),b=buy(s),p=prepareExecutionFill(s,b.round.id,{editId:b.fill.id,qty:60,price:101,at:now,reason:'券商实际成交更正'},now);
  near(p.round.plan.stop,98.8285);near(p.round.initialRisk,130.29);assert.equal(p.round.executionModel.stopPct,.0215);near(b.round.initialRisk,107.5);
  validateState({...s,rounds:[p.round]});
});
test('旧规则交易更正只计算真实成交，原风险、止损、退出规则保留',()=>{
  const s=defaultState();s.draft.plan={...s.draft.plan,entry:100,stop:98};s.draft.reason='旧记录';s.draft.events='已评估';
  const r=newRound(s);r.entrySource='actual';r.fills=[{id:'legacy-entry',at:now,side:'buy',kind:'entry',qty:50,price:100,fee:1,plannedPrice:100,reason:'旧实际买入',reasonCode:'manual',trendConfirmed:false,violations:[],sequence:0}];s.rounds.push(r);
  const before=structuredClone(r),p=prepareExecutionFill(s,r.id,{editId:'legacy-entry',qty:50,price:100.1,at:now,reason:'更正'},now);
  assert.equal(p.round.initialRisk,before.initialRisk);assert.deepEqual(p.round.plan,before.plan);assert.equal(p.round.exitPlan,before.exitPlan);assert.equal(p.fill.fee,1);assert.equal(p.fill.plannedPrice,100);
});
test('新旧交易及旧版未成交档案无损备份，隐藏界面不删除档案',()=>{
  const s=defaultState();s.draft.plan={...s.draft.plan,entry:100,stop:98};const pending=newRound(s);s.rounds.push(pending);const b=buy(s,input('MSTU',{qty:10}));exit(s,b.round.id,106.6);
  assert.equal(statistics(s).total,1);assert.deepEqual(importBackupCSV(exportBackupCSV(s)),s);assert.equal(s.rounds[0].fills.length,0);
  const corrupt=structuredClone(s);corrupt.rounds[1].executionModel.stopPct=.01;assert.throws(()=>validateState(corrupt),/快照|参考参数/);
});
test('连续两笔止损仍触发美东当天暂停，不受全额退出方案影响',()=>{
  const s=defaultState();for(const symbol of ['SOXL','AGQ']){const b=buy(s,input(symbol));exit(s,b.round.id,b.round.plan.stop,{reasonCode:'stop'});}
  assert.equal(tradingGuard(s,later).blocked,true);assert.match(prepareExecutionBuy(s,input('LABU',{at:later}),later).fill.violations.join(' '),/暂停/);
});
test('更正成交不抹去已存在的规则偏离，不能借此提高遵守率',()=>{
  const s=defaultState(),b=buy(s),sold=exit(s,b.round.id,101);
  assert.equal(sold.check.pass,false);
  const corrected=prepareExecutionFill(s,b.round.id,{editId:sold.fill.id,qty:50,price:104.3,at:later,reasonCode:'target',reason:'实际价格更正'},later);
  assert.equal(corrected.check.pass,false);assert.match(corrected.fill.violations.join(' '),/未到/);
  assert.equal(corrected.round.review.compliant,false);near(accounting(corrected.round).r,2);
});
