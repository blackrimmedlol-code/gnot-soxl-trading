// NYSE published calendar, 2026–2028. Unknown years fail closed.
const CLOSED=new Set(('2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 '+
  '2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 '+
  '2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25').split(' '));
const HALF=new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
export function marketDay(day){const year=Number(day.slice(0,4)),dow=new Date(day+'T12:00:00Z').getUTCDay();return year>=2026&&year<=2028&&dow>0&&dow<6&&!CLOSED.has(day);}
const plusDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
export function nextTradingDay(day,{full=false}={}){for(let i=0;i<370;i++){day=plusDay(day);if(marketDay(day)&&(!full||!HALF.has(day)))return day;}return null;}
export function marketClock(at=new Date().toISOString()){
  const d=new Date(at);if(!Number.isFinite(d.getTime()))return {valid:false};
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
  const day=`${p.year}-${p.month}-${p.day}`,minute=Number(p.hour)*60+Number(p.minute),open=marketDay(day),half=HALF.has(day);
  const close=half?780:960, tomorrow=plusDay(day),beforeBreak=open&&!marketDay(tomorrow);
  return {valid:true,day,minute,half,open,close,regular:open&&minute>=570&&minute<close,entry:open&&!half&&minute>=630&&minute<930,beforeBreak,exitDue:beforeBreak&&minute>=close-5&&minute<close};
}
