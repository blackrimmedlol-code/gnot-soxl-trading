import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultState,newRound,checksFor,selectDraft,calculateDraft,portfolioRisk,previewFill,statistics,tradingGuard,validateState,exportBackupCSV,importBackupCSV,mergeStates} from '../dist/core.js';
import {loadStorage,saveStorage,STORAGE_KEY} from '../dist/storage.js';

const at='2026-11-05T15:00:00Z';let seq=0;
function make(symbol='SOXL',stop=49){
  const s=defaultState();s.draft.symbol=symbol;
  s.draft.plan={...s.draft.plan,equity:25000,amount:5000,entry:50,stop,targetR:2};
  s.draft.checks=Object.fromEntries(checksFor(symbol).map(([k])=>[k,true]));
  s.draft.reason='大级别支撑与十五分钟确认';s.draft.events='已评估重大事件与隔夜风险';s.draft.environment='risk-on';
  return newRound(s);
}
function fill(side,qty,price,extra={}){return {id:'multi-fill-'+(++seq),sequence:seq,at,side,qty,price,fee:0,kind:side==='buy'?'entry':'exit',plannedPrice:null,targetPrice:null,reason:'券商真实成交',reasonCode:'manual',trendConfirmed:false,violations:[],...extra};}
function state(...rounds){const s=defaultState();s.rounds=rounds;return s;}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('三标的计划分别冻结对应标的与清单，旧 SOXL 草稿仍默认 SOXL',()=>{
  for(const symbol of ['SOXL','AGQ','LABU']){const r=make(symbol);assert.equal(r.symbol,symbol);assert.match(r.title,new RegExp(symbol));assert.equal(r.checkLabels.support,`已识别 ${symbol} 大级别支撑`);validateState(state(r));}
  const s=defaultState();delete s.draft.symbol;s.draft.plan=make().plan;assert.equal(newRound(s).symbol,'SOXL');
});
test('白银与生科清单不会继承半导体环境，9 个旧字段保持兼容',()=>{
  assert.match(checksFor('AGQ').find(([k])=>k==='market')[1],/白银/);
  assert.match(checksFor('LABU').find(([k])=>k==='market')[1],/XBI/);
  assert.deepEqual(checksFor('AGQ').map(([k])=>k),checksFor('SOXL').map(([k])=>k));
});
test('切换标的保留各自价格、清单和理由，当前账户权益共同使用',()=>{
  let s=defaultState();s.draft.plan.entry=50;s.draft.checks.support=true;s.draft.reason='SOXL 计划';
  s=selectDraft(s,'AGQ');assert.equal(s.draft.plan.entry,'');assert.equal(s.draft.checks.support,undefined);
  s.draft.plan.entry=70;s.draft.plan.equity=24000;s.draft.reason='AGQ 计划';
  s=selectDraft(s,'LABU');s.draft.plan.entry=200;s=selectDraft(s,'SOXL');
  assert.equal(s.draft.plan.entry,50);assert.equal(s.draft.reason,'SOXL 计划');assert.equal(s.draft.checks.support,true);assert.equal(s.draft.plan.equity,24000);
  s=selectDraft(s,'AGQ');assert.equal(s.draft.plan.entry,70);assert.equal(s.draft.reason,'AGQ 计划');
});
test('分标的统计不混入其他标的，历史 RAM 仍排除，账户曲线保持统一',()=>{
  const a=make('SOXL'),b=make('AGQ'),c=make('LABU'),h=make();h.scope='history';h.symbol='RAM';
  a.fills=[fill('buy',10,50),fill('sell',10,52)];b.fills=[fill('buy',20,50),fill('sell',20,49)];c.fills=[fill('buy',10,50)];h.fills=[fill('buy',100,50),fill('sell',100,100)];
  const s=state(a,b,c,h);s.snapshots=[{id:'snap-multi',at,equity:24000,flow:0,note:'真实账户权益'}];
  assert.equal(statistics(s).total,2);near(statistics(s).realized,0);
  assert.equal(statistics(s,'SOXL').winRate,1);assert.equal(statistics(s,'AGQ').winRate,0);assert.equal(statistics(s,'LABU').winRate,null);
  assert.deepEqual(statistics(s,'AGQ').snapshots,statistics(s,'SOXL').snapshots);
});
test('组合风险只计真实持仓；空计划、已清仓与历史分类不占预算',()=>{
  const a=make('SOXL'),b=make('AGQ'),planned=make('LABU'),h=make();h.scope='history';h.symbol='RAM';
  a.fills=[fill('buy',100,50)];b.fills=[fill('buy',20,50),fill('sell',20,49)];h.fills=[fill('buy',100,50)];
  const p=portfolioRisk(state(a,b,planned,h));near(p.risk,100);assert.equal(p.positions.length,1);
});
test('单轮均未超预算，合计风险超 1% 时新计划仍不合规',()=>{
  const a=make('SOXL',48);a.fills=[fill('buy',100,50)];const s=state(a);s.draft.symbol='AGQ';s.draft.plan={...make('AGQ').plan};
  const c=calculateDraft(s);near(c.risk,100);near(c.availableRisk,50);near(c.combinedRisk,300);assert.equal(c.pass,false);assert.match(c.violations.join(' '),/合计/);
});
test('三标的共同持仓可以通过，合计到 250 美元边界仍合规',()=>{
  const a=make('SOXL'),b=make('AGQ');a.fills=[fill('buy',100,50)];b.fills=[fill('buy',50,50)];const c=make('LABU');
  const s=state(a,b,c),f=fill('buy',100,50);const p=portfolioRisk(s,{excludeId:c.id});
  near(p.risk,150);assert.equal(previewFill(c,f,{portfolio:p,currentEquity:25000,otherOpen:false}).pass,true);
});
test('不同标的成交也核对共同预算，超额真实成交保留可记录的违规结果',()=>{
  const a=make('SOXL',48),b=make('LABU');a.fills=[fill('buy',100,50)];
  const result=previewFill(b,fill('buy',100,50),{portfolio:portfolioRisk(state(a,b),{excludeId:b.id}),currentEquity:25000});
  assert.equal(result.after.qty,100);assert.equal(result.pass,false);assert.match(result.violations.join(' '),/合计/);
});
test('跨标的利润不能抵消新仓风险，已上移止损仅释放当前风险',()=>{
  const a=make('SOXL',48);a.fills=[fill('buy',100,50),fill('sell',50,55,{kind:'partial'})];
  const s=state(a);near(portfolioRisk(s).risk,100);
  a.stopEvents=[{id:'stop-multi',at:'2026-11-05T15:10:00Z',price:50,reason:'结构确认上移'}];near(portfolioRisk(s).risk,0);
  near(portfolioRisk(s,{asOf:at}).risk,100);
});
test('补录历史成交风险不使用其他仓位未来成交或未来止损',()=>{
  const a=make('SOXL',48);a.fills=[fill('buy',100,50,{at:'2026-11-05T15:10:00Z'})];
  near(portfolioRisk(state(a),{asOf:at}).risk,0);
  near(portfolioRisk(state(a),{asOf:'2026-11-05T15:20:00Z'}).risk,200);
});
test('不同标的连续止损仍暂停整个账户当日开仓，次日恢复',()=>{
  const a=make('SOXL'),b=make('AGQ');
  a.fills=[fill('buy',10,50,{at:'2026-11-05T14:00:00Z'}),fill('sell',10,49,{at:'2026-11-05T14:30:00Z',reasonCode:'stop'})];
  b.fills=[fill('buy',10,50,{at:'2026-11-05T14:45:00Z'}),fill('sell',10,49,{at:'2026-11-05T15:00:00Z',reasonCode:'stop'})];
  assert.equal(tradingGuard(state(a,b),'2026-11-05T16:00:00Z').blocked,true);assert.equal(tradingGuard(state(a,b),'2026-11-06T16:00:00Z').blocked,false);
});
test('旧 V1 SOXL 数据无迁移改写；价格、旧费用、冻结风险和原清单保持原值',()=>{
  const r=make();delete r.checkLabels;r.plan.costs=2;r.initialRisk+=2;r.fills=[fill('buy',10,50,{fee:1,plannedPrice:49.9})];const s=state(r);delete s.draft.symbol;
  assert.deepEqual(validateState(s),s);assert.deepEqual(importBackupCSV(exportBackupCSV(s)),s);
});
test('三标的 CSV／JSON 无损恢复冻结清单与各标的草稿',()=>{
  let s=state(make('SOXL'),make('AGQ'),make('LABU'));s.draft.plan.entry=50;s=selectDraft(s,'AGQ');s.draft.plan.entry=70;s=selectDraft(s,'LABU');
  assert.deepEqual(importBackupCSV(exportBackupCSV(s)),s);assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))),s);
});
test('已有 SOXL 数据与新标的数据安全合并，同 ID 异内容仍拒绝',()=>{
  const a=make('SOXL'),b=make('AGQ');const local=state(a),imported=state(b);assert.equal(mergeStates(local,imported).rounds.length,2);
  const conflict=structuredClone(local);conflict.rounds[0].symbol='LABU';assert.throws(()=>mergeStates(local,conflict),/冲突/);
});
test('未授权主动标的及伪造草稿键拒绝，不扩大交易池',()=>{
  for(const symbol of ['RAM','NVDA','toString','__proto__']){const s=state(make());s.rounds[0].symbol=symbol;assert.throws(()=>validateState(s));assert.throws(()=>selectDraft(defaultState(),symbol));}
});
test('旧存储键加载与新版刷新保留三标的，切换草稿不会丢失 SOXL 记录',async()=>{
  const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v))};
  const old=state(make());delete old.draft.symbol;map.set(STORAGE_KEY,JSON.stringify(old));
  let s=loadStorage(storage).state;assert.equal(s.rounds[0].symbol,'SOXL');s=selectDraft(s,'AGQ');s.rounds.push(make('AGQ'));
  s=await saveStorage(s,s.revision,{storage});const read=loadStorage(storage);assert.equal(read.error,null);assert.deepEqual(read.state,s);assert.equal(read.state.rounds.length,2);
});
