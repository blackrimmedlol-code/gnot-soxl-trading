import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultState,newRound,checksFor,selectDraft,breakevenStop,accounting,effectiveStop,positionRisk,portfolioRisk,previewFill,statistics,validateState,exportBackupCSV,importBackupCSV} from '../dist/core.js';

let seq=0;
function setup(symbol='MSTU'){
  const s=defaultState();s.draft.symbol=symbol;s.draft.plan={...s.draft.plan,entry:50,stop:48,amount:5000};s.draft.environment='risk-on';
  s.draft.reason='30 分钟结构与 15 分钟确认';s.draft.events='已评估底层与隔夜风险';s.draft.checks=Object.fromEntries(checksFor(symbol).map(([k])=>[k,true]));
  const r=newRound(s);s.rounds.push(r);return {s,r};
}
function fill(side,qty,price,extra={}){return {id:'exit-fill-'+(++seq),sequence:seq,at:new Date(Date.parse('2026-11-05T15:00:00Z')+seq*1000).toISOString(),side,qty,price,fee:0,kind:side==='buy'?'entry':'partial',plannedPrice:null,reason:'实际成交',reasonCode:'manual',trendConfirmed:false,violations:[],...extra};}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('MSTU 可作为主动交易，冻结 MSTR／BTC 清单与新的退出指引',()=>{
  const {s,r}=setup();assert.equal(r.symbol,'MSTU');assert.match(r.checkLabels.market,/MSTR.*BTC/);assert.match(r.checkLabels.event,/周末/);assert.match(r.exitPlan,/实际成本均价/);validateState(s);
});
test('MSTU 草稿与其他三只互不污染，JSON／CSV 保留四标的数据',()=>{
  let {s}=setup('SOXL');s=selectDraft(s,'MSTU');s.draft.plan.entry=40;s.draft.reason='MSTU 独立计划';s=selectDraft(s,'AGQ');s.draft.plan.entry=70;s=selectDraft(s,'MSTU');
  assert.equal(s.draft.plan.entry,40);assert.equal(s.draft.reason,'MSTU 独立计划');assert.deepEqual(importBackupCSV(exportBackupCSV(s)),s);
});
test('新增主动 MSTU 不把旧 MSTU 历史记录计入绩效',()=>{
  const {s,r}=setup(),history=structuredClone(r);history.id='old-mstu-history';history.scope='history';history.fills=[fill('buy',100,50),fill('sell',100,60)];s.rounds.push(history);
  r.fills=[fill('buy',100,50),fill('sell',100,52)];assert.equal(statistics(s,'MSTU').total,1);near(statistics(s,'MSTU').realized,200);validateState(s);
});
test('第四只实际成交也受共用 1% 预算约束',()=>{
  const {s,r}=setup(),{r:other}=setup('SOXL');other.fills=[fill('buy',100,50)];s.rounds.push(other);
  const result=previewFill(r,fill('buy',100,50),{portfolio:portfolioRisk(s,{excludeId:r.id}),currentEquity:25000});assert.equal(result.pass,false);assert.match(result.violations.join(' '),/四标的合计/);
});
test('2R 卖半后保本退出，理想成交下整轮为 +1R，参考按钮不生成订单或止损事件',()=>{
  const {r}=setup();r.fills=[fill('buy',100,50),fill('sell',50,54)];const before=structuredClone(r),reference=breakevenStop(r);
  near(reference.price,50);assert.equal(reference.qty,50);assert.deepEqual(r,before);assert.equal(r.stopEvents.length,0);near(positionRisk(r).risk,100);
  r.stopEvents.push({id:'break-even-event',at:'2026-11-05T16:00:00Z',price:reference.price,reason:'实际减半后保本'});near(positionRisk(r).risk,0);
  r.fills.push(fill('sell',50,50,{kind:'exit',at:'2026-11-05T16:01:00Z'}));near(accounting(r).realized,200);near(accounting(r).r,1);
});
test('2R 卖半后剩余在 4R 退出，整轮为 +3R；R 分母未改变',()=>{
  const {r}=setup();r.fills=[fill('buy',100,50),fill('sell',50,54),fill('sell',50,58,{kind:'exit'})];near(r.initialRisk,200);near(accounting(r).realized,600);near(accounting(r).r,3);
});
test('保本价使用实际多笔买入后的加权成本，不使用计划入场价或首次买价',()=>{
  const {r}=setup();r.fills=[fill('buy',60,50),fill('buy',40,52,{kind:'add',trendConfirmed:true}),fill('sell',50,55)];near(breakevenStop(r).average,50.8);near(breakevenStop(r).price,50.8);
});
test('已有高于成本的止损不下移；小数精度向上取整不低于成本',()=>{
  const {r}=setup();r.fills=[fill('buy',3,50.123456)];r.stopEvents=[{id:'higher-stop',at:'2026-11-05T16:00:00Z',price:51.000001,reason:'结构上移'}];const ref=breakevenStop(r);assert.ok(ref.price>=effectiveStop(r));assert.ok(ref.price>=accounting(r).avg);
});
test('计划未成交与已退出轮没有保本参考价',()=>{
  const {r}=setup();assert.equal(breakevenStop(r),null);r.fills=[fill('buy',10,50),fill('sell',10,52)];assert.equal(breakevenStop(r),null);
});
test('新增 MSTU 支持不会改写旧轮的退出计划、冻结风险与历史分类',()=>{
  const {s,r}=setup('SOXL');r.exitPlan='旧规则：2R减半，剩余按结构退出';const before=structuredClone(s);assert.deepEqual(validateState(s),before);assert.deepEqual(importBackupCSV(exportBackupCSV(s)),before);
});
