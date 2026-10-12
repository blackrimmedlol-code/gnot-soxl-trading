import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeAmount,calculatePlan,defaultState,newRound,validateState,accounting,exportBackupCSV,importBackupCSV} from '../dist/core.js';

const base=()=>({...defaultState().draft.plan,entry:50,stop:48,quantity:100});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('按股数计算金额及风险，不反向修改股数或价格',()=>{
  const plan={...base(),amount:99999},original=structuredClone(plan),result=calculatePlan(plan);
  assert.equal(result.qty,100);assert.equal(result.invested,5000);assert.equal(result.risk,200);
  assert.equal(result.pass,true);assert.deepEqual(plan,original);
  assert.equal(tradeAmount('100','50'),5000);
});
test('小数成交价保持输入整股数，价格变化自动对应新金额',()=>{
  const plan={...base(),quantity:17,entry:53.17,stop:51.17};
  const result=calculatePlan(plan);assert.equal(result.qty,17);near(result.invested,903.89);near(result.risk,34);
  plan.entry=54.23;near(calculatePlan(plan).invested,921.91);assert.equal(calculatePlan(plan).qty,17);
});
test('空白、小数、负数和不安全整数股数不产生有效计划或金额',()=>{
  for(const quantity of ['',null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
    assert.equal(tradeAmount(quantity,50),null);
    assert.equal(calculatePlan({...base(),quantity}).valid,false);
  }
  assert.equal(tradeAmount(100,''),null);assert.equal(tradeAmount(2,1e308),null);
});
test('按股数超风险预算仍拒绝，不偷偷缩股或改变技术止损',()=>{
  const plan={...base(),quantity:200},original=structuredClone(plan),result=calculatePlan(plan);
  assert.equal(result.qty,200);assert.equal(result.risk,400);assert.equal(result.pass,false);
  assert.match(result.violations.join(' '),/1%/);assert.deepEqual(plan,original);
});
test('四标的新计划冻结正确股数和金额，备份保留数量及原始 R',()=>{
  for(const symbol of ['SOXL','AGQ','LABU','MSTU']){
    const state=defaultState();state.draft.symbol=symbol;state.draft.plan={...base(),amount:99999};
    state.draft.sizingMode='shares';state.draft.quantity=100;const round=newRound(state);
    assert.equal(round.plan.quantity,100);assert.equal(round.plan.amount,5000);assert.equal(round.initialRisk,200);
    state.rounds=[round];validateState(state);
    assert.deepEqual(importBackupCSV(exportBackupCSV(state)),state);
    const bad=structuredClone(state);bad.rounds[0].plan.amount=4999;assert.throws(()=>validateState(bad),/金额.*股数/);
  }
});
test('股数计划部分止盈及旧金额计划沿用原有盈亏口径',()=>{
  const state=defaultState();state.draft.plan=base();const round=newRound(state);
  const fill=(id,side,qty,price)=>({id,at:`2026-10-10T15:00:0${id}Z`,side,qty,price,fee:0,plannedPrice:null,kind:side==='buy'?'entry':'partial',reason:'数量验收',reasonCode:'manual',violations:[],trendConfirmed:false,sequence:Number(id)});
  round.fills=[fill('1','buy',100,50),fill('2','sell',50,54),fill('3','sell',50,50)];
  const result=accounting(round);assert.equal(result.qty,0);assert.equal(result.realized,200);assert.equal(result.r,1);
  const legacy=base();delete legacy.quantity;legacy.amount=5000;legacy.entry=53.17;
  assert.equal(calculatePlan(legacy).qty,94);
});
