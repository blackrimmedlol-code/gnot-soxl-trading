import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultState,accounting,validateState,exportBackupCSV,importBackupCSV,statistics} from '../dist/core.js';
import {ensureWorkbench,calculateWorkbench,prepareDisciplineBuy,prepareDisciplineFill} from '../dist/discipline.js';
import {activateRisk,executionReview,disciplineGuard} from '../dist/risk.js';
import {decisionChecks,decisionExplanation,captureEntryCheck,entryAuditHTML,saveReview,matchesError,reviewDiagnostics,errorTags,initialRiskHTML} from '../dist/execution-insights.js';

const now='2026-10-19T14:35:00Z',bar='2026-10-19T14:30:00Z';
const data=(extra={})=>({entry:100,atr:3,low:96,high:99,close30:100,close1h:100,ema20:99,ema50:95,hourAt:bar,signalAt:bar,...extra});
function state(){const s=defaultState();ensureWorkbench(s);s.settings.initialEquity=30000;s.settings.startDate='2026-01-01';s.workbench.activatedAt='2026-10-19T13:30:00Z';s.workbench.inputs.SOXL=data();s.workbench.equityDay='2026-10-19';activateRisk(s,{equity:30000,at:'2026-10-19T13:30:00Z',confirmed:true},now);return s;}
function buy(s,symbol='SOXL',extra={}){const result=calculateWorkbench(s,symbol,extra.snapshot??data(),now);const snapshot={...data(),entryCheck:captureEntryCheck(result),...extra.snapshot};const b=prepareDisciplineBuy(s,{symbol,price:100,qty:10,at:now,reason:'隔离验收，不进入用户数据',snapshot,...extra},now);s.rounds.push(b.round);b.round.mark={price:100,at:now};return b.round;}
function close(price,review=null){const s=state(),r=buy(s),p=prepareDisciplineFill(s,r.id,{side:'sell',price,qty:10,at:'2026-10-19T14:40:00Z',reasonCode:price>=109?'target':'stop',reason:'隔离测试退出'},'2026-10-19T14:40:00Z');if(review)saveReview(p.round,{compliant:'yes',rating:'4',notes:'核对完整',...review},'2026-10-19T14:45:00Z');return p.round;}

test('资料缺失保持待核对，不能显示为趋势不合格或允许执行',()=>{
  const s=state(),r=calculateWorkbench(s,'SOXL',{entry:100,atr:3,low:96},now);
  assert.equal(r.referenceQty,75);assert.equal(r.qty,0);
  assert.equal(decisionExplanation(r).code,'trend-data');
  assert.equal(decisionChecks(r).find(x=>x.id==='trend').status,'pending');
  assert.equal(decisionChecks(r).find(x=>x.id==='breakout').status,'pending');
  assert.equal(decisionChecks(r).find(x=>x.id==='time').status,'pending');
});
test('已核对趋势失败与过期趋势分别显示，不混成一个原因',()=>{
  const s=state();let r=calculateWorkbench(s,'SOXL',data({ema20:90}),now);
  assert.equal(decisionExplanation(r).code,'trend-off');assert.equal(decisionChecks(r)[0].status,'wait');
  r=calculateWorkbench(s,'SOXL',data({hourAt:'2026-10-16T14:30:00Z'}),now);
  assert.equal(decisionExplanation(r).code,'trend-data');assert.equal(decisionChecks(r)[0].status,'pending');
});
test('缺失账户数据不冒充0风险额度；休市不冒充趋势失败',()=>{
  const s=state();s.workbench.risk.baseline=null;
  assert.equal(decisionExplanation(calculateWorkbench(s,'SOXL',data(),now)).code,'account-data');
  const r=calculateWorkbench(state(),'SOXL',data(),'2026-10-18T14:35:00Z');
  assert.equal(decisionExplanation(r).code,'session');assert.equal(r.qty,0);
});
test('未来收盘时间待核对，过期信号明确等待新信号',()=>{
  let r=calculateWorkbench(state(),'SOXL',data({signalAt:'2026-10-19T15:00:00Z'}),now);
  assert.equal(decisionChecks(r).find(x=>x.id==='time').status,'pending');
  r=calculateWorkbench(state(),'SOXL',data(),'2026-10-19T15:00:00Z');
  assert.equal(decisionChecks(r).find(x=>x.id==='time').status,'wait');assert.equal(r.qty,0);
});
test('两笔用满组合风险后第三笔0股，原因明确指向风险并且浮盈不释放',()=>{
  const s=state(),wide=data({atr:4});
  for(const symbol of ['SOXL','GDXU','BITX'])s.workbench.inputs[symbol]=wide;
  for(const symbol of ['SOXL','GDXU'])buy(s,symbol,{qty:75,snapshot:wide});
  s.rounds.forEach(r=>r.mark={price:110,at:now});
  const result=calculateWorkbench(s,'BITX',wide,now),reason=decisionExplanation(result);
  assert.equal(result.portfolio.risk,900);assert.equal(result.capacityQty,0);assert.equal(result.qty,0);
  assert.equal(reason.code,'capacity');assert.match(reason.detail,/风险/);
});
test('缺少持仓估值优先解释资料未知，不能解释为现金已用完',()=>{
  const s=state(),r=buy(s);r.mark=null;s.workbench.inputs.GDXU=data();
  assert.equal(decisionExplanation(calculateWorkbench(s,'GDXU',data(),now)).code,'positions-data');
});
test('完整条件返回真实股数，减股数仍保留原止损与目标',()=>{
  const s=state(),r=calculateWorkbench(s,'SOXL',data({requestedQty:40}),now);
  assert.equal(r.qty,40);assert.equal(r.levels.stop,95.5);assert.equal(r.levels.target,109);
  assert.equal(decisionExplanation(r).code,'ready');assert.match(decisionExplanation(r).title,/40/);
});
test('未满足时核对快照保存0股；通过时保存核对时间与允许股数',()=>{
  const s=state(),r=calculateWorkbench(s,'SOXL',data(),now),c=captureEntryCheck(r);
  assert.equal(c.at,now);assert.equal(c.ready,true);assert.equal(c.allowedQty,75);assert.equal(c.checks.length,6);
  const failed=captureEntryCheck(calculateWorkbench(s,'SOXL',{entry:100,atr:3,low:96},now));
  assert.equal(failed.ready,false);assert.equal(failed.allowedQty,0);
});
test('实际成交冻结原核对快照，工作台改变不会重写已成交证据与R',()=>{
  const s=state(),r=buy(s),before=structuredClone(r.executionModel.inputSnapshot);
  s.workbench.inputs.SOXL=data({atr:20,entry:200});
  assert.deepEqual(r.executionModel.inputSnapshot,before);assert.equal(r.plan.stop,95.5);assert.equal(r.initialRisk,45);
  assert.match(entryAuditHTML(r),/入场前计算通过/);assert.match(initialRiskHTML(r),/45/);
});
test('事后核对与旧记录缺少核对时间不能伪装成事前通过',()=>{
  const s=state(),r=buy(s);
  r.executionModel.inputSnapshot.entryCheck.at='2026-10-19T14:36:00Z';
  assert.match(entryAuditHTML(r),/核对晚于成交/);assert.doesNotMatch(entryAuditHTML(r),/入场前计算通过/);
  delete r.executionModel.inputSnapshot.entryCheck;
  assert.match(entryAuditHTML(r),/未留核对时间/);assert.doesNotMatch(entryAuditHTML(r),/入场前计算通过/);
});
test('错误标签不修改真实金额，违纪盈利也不能变成守纪',()=>{
  const r=close(109),before=accounting(r);
  saveReview(r,{compliant:'yes',rating:3,notes:'抢跑后碰巧盈利',errorTag:'early'},'2026-10-19T15:00:00Z');
  assert.equal(executionReview(r),'breach');assert.equal(r.review.compliant,false);assert.deepEqual(accounting(r),before);
  saveReview(r,{compliant:'yes',rating:5,notes:'更正备注',errorTag:'none'},'2026-10-22T15:00:00Z');
  assert.equal(executionReview(r),'breach');assert.equal(matchesError(r,'early'),true);assert.equal(matchesError(r,'none'),false);
});
test('空白标签不等于无偏离，标签与待核对评价分别保留',()=>{
  const r=close(100);assert.equal(matchesError(r,'untagged'),true);assert.equal(matchesError(r,'none'),false);
  saveReview(r,{compliant:'unknown',rating:0,notes:'',errorTag:'none'},'2026-10-19T15:00:00Z');
  assert.equal(executionReview(r),'pending');assert.equal(matchesError(r,'none'),true);
});
test('修改复盘备注不会把已恢复的旧偏离重新计为今天的新偏离',()=>{
  const s=state(),r=buy(s);
  saveReview(r,{compliant:'yes',rating:3,notes:'确认抢跑',errorTag:'early'},now);
  s.workbench.recoveries.push({at:'2026-10-21T14:00:00Z',notes:'已完成规定休息并核对退出订单与下一笔风险',ordersResolved:true});
  assert.equal(disciplineGuard(s,'2026-10-21T15:00:00Z').blocked,false);
  saveReview(r,{compliant:'yes',rating:4,notes:'只更改文字',errorTag:'early'},'2026-10-23T15:00:00Z');
  assert.equal(r.review.breachAt,now);assert.equal(disciplineGuard(s,'2026-10-23T15:00:00Z').blocked,false);
});
test('诊断分组覆盖全部完整实盘，不隐藏待核对或违纪结果',()=>{
  const good=close(109,{errorTag:'none'}),bad=close(95.5,{errorTag:'risk'}),pending=close(100),rs=[good,bad,pending];
  const d=reviewDiagnostics(rs);assert.equal(d.groups.all.count,3);assert.equal(d.groups.compliant.count,1);assert.equal(d.groups.breach.count,1);assert.equal(d.groups.pending.count,1);
  assert.ok(Math.abs(d.groups.all.avgR-1/3)<1e-9);assert.equal(d.groups.compliant.avgR,2);assert.equal(d.errors.risk,1);assert.equal(d.untagged,1);
  assert.equal(rs.filter(r=>matchesError(r,'risk')).length,1);assert.equal(reviewDiagnostics([]).groups.all.avgR,null);
});
test('同一交易重复标签只统计一次，新的已确认标签继续保留',()=>{
  const r=close(109);for(const [i,tag] of ['early','early','revenge'].entries())saveReview(r,{compliant:'no',rating:1,notes:'测试偏离归因',errorTag:tag},new Date(Date.parse(now)+i*60000).toISOString());
  assert.deepEqual(errorTags(r),['early','revenge']);const x=reviewDiagnostics([r]);assert.equal(x.errors.early,1);assert.equal(x.errors.revenge,1);
});
test('JSON与完整CSV无损保留错误标签、历史与核对证据',()=>{
  const s=state(),r=buy(s);saveReview(r,{compliant:'no',rating:2,notes:'测试标签备份',errorTag:'revenge'},now);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))),s);assert.deepEqual(importBackupCSV(exportBackupCSV(s)),s);
  const bad=structuredClone(s);bad.rounds[0].review.compliant=true;
  assert.equal(executionReview(validateState(bad).rounds[0]),'breach');
});
test('非法标签和矛盾核对快照拒绝导入，旧快照仍然兼容',()=>{
  const s=state(),r=buy(s);delete r.executionModel.inputSnapshot.entryCheck;
  assert.deepEqual(validateState(s),s);assert.match(entryAuditHTML(r),/未留核对时间/);
  let bad=structuredClone(s);bad.rounds[0].review.errorTag='unrecognized';assert.throws(()=>validateState(bad),/标签/);
  bad=structuredClone(s);bad.rounds[0].executionModel.inputSnapshot.entryCheck={...captureEntryCheck(calculateWorkbench(state(),'SOXL',data(),now)),allowedQty:0};assert.throws(()=>validateState(bad),/快照/);
});
