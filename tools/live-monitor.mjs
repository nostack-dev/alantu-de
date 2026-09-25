import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const url=process.env.MONITOR_URL||'https://www.alantu.de/';
const out=process.env.MONITOR_OUT||'/tmp/alantu-live-monitor';
const iterations=Math.max(1,Number(process.env.MONITOR_ITERATIONS||19));
const intervalMs=Math.max(1000,Number(process.env.MONITOR_INTERVAL_MS||600000));
await fs.mkdir(out,{recursive:true});

const browser=await chromium.launch({headless:true});
const configs=[
  {name:'desktop',viewport:{width:1440,height:1000},mobile:false},
  {name:'mobile',viewport:{width:390,height:844},mobile:true}
];
const sessions=[];
for(const cfg of configs){
  const context=await browser.newContext({viewport:cfg.viewport,isMobile:cfg.mobile,hasTouch:cfg.mobile});
  const page=await context.newPage();
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(5000);
  sessions.push({...cfg,context,page});
}

const rows=[],hardErrors=[];
let previous=null;

async function sampleSession(s,idx){
  const {page,name,mobile}=s;
  const consoleErrors=[],pageErrors=[];
  const onConsole=m=>{if(m.type()==='error')consoleErrors.push(m.text());};
  const onPageError=e=>pageErrors.push(String(e?.stack||e));
  page.on('console',onConsole);page.on('pageerror',onPageError);
  try{
    if(page.isClosed())throw new Error(name+' page closed');
    await page.evaluate(()=>{if(typeof setChartRange==='function')setChartRange('price','1d');});
    await page.waitForTimeout(500);
    const canvas=page.locator('#ivChart');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
    if(!box)throw new Error(name+' ivChart missing');

    if(mobile){
      const cdp=await page.context().newCDPSession(page);
      const y=box.y+box.height*.5,x0=box.x+box.width*.55,x1=box.x+box.width*.75;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x0,y}]});
      await page.waitForTimeout(260);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x1,y}]});
      await page.waitForTimeout(180);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else{
      await page.mouse.move(box.x+box.width*.58,box.y+box.height*.5);
      await page.waitForTimeout(180);
      await page.mouse.move(box.x+box.width*.76,box.y+box.height*.5);
    }

    const snap=await page.evaluate(()=>({
      at:new Date().toISOString(),
      ready:document.readyState,
      overflow:document.documentElement.scrollWidth-window.innerWidth,
      priceRange:typeof priceRange==='undefined'?null:priceRange,
      priceAxis:(ivChart?.scales?.x)?{
        min:Number(ivChart.scales.x.min),max:Number(ivChart.scales.x.max),
        minBerlin:new Date(ivChart.scales.x.min).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'}),
        maxBerlin:new Date(ivChart.scales.x.max).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'})
      }:null,
      scrub:{
        active:typeof priceScrubState!=='undefined'&&!!priceScrubState.active,
        source:typeof priceScrubState!=='undefined'?priceScrubState.source:null,
        point:typeof priceScrubState!=='undefined'&&priceScrubState.point?priceScrubState.point:null
      },
      projection:{
        hintVisible:!!document.getElementById('projectionHint')&&!document.getElementById('projectionHint').hidden,
        path:(ivChart?.data?.datasets||[]).find(d=>d.label==='Projektionspfad')?.data||[],
        band:(ivChart?.data?.datasets||[]).find(d=>d.label==='Unsicherheitsband')?.data||[]
      },
      data:{
        usMinutes:Array.isArray(orclMinuteBars)?orclMinuteBars.length:0,
        usLast:Array.isArray(orclMinuteBars)&&orclMinuteBars.length?orclMinuteBars[orclMinuteBars.length-1].at:null,
        deMinutes:Array.isArray(orclGermanyBars)?orclGermanyBars.length:0,
        deLast:Array.isArray(orclGermanyBars)&&orclGermanyBars.length?orclGermanyBars[orclGermanyBars.length-1].at:null,
        daily:Array.isArray(orclDailyBars)?orclDailyBars.length:0,
        dailyLast:Array.isArray(orclDailyBars)&&orclDailyBars.length?orclDailyBars[orclDailyBars.length-1].at:null,
        sentimentHistory:(sentimentBackfillData&&Array.isArray(sentimentBackfillData.history))?sentimentBackfillData.history.length:0,
        sentimentLast:(sentimentBackfillData&&Array.isArray(sentimentBackfillData.history)&&sentimentBackfillData.history.length)?sentimentBackfillData.history[sentimentBackfillData.history.length-1].at:null,
        sourceArchive:Number(liveSourceState?.archive_count||0),
        sourceLatest:liveSourceState?.latest_published_at||liveSourceState?.at||null
      },
      storage:{
        price:localStorage.getItem('alantu_price_range_v1'),
        intrinsic:localStorage.getItem('alantu_intrinsic_visible_v1'),
        chartOpen:localStorage.getItem('alantu_chart_open_v1'),
        sentimentLocal:(()=>{try{const x=JSON.parse(localStorage.getItem('alantu_orcl_sentiment_history_v1')||'[]');return Array.isArray(x)?x.length:-1;}catch{return -1;}})()
      },
      live:{
        price:(document.getElementById('livePrice')?.textContent||'').trim(),
        change:(document.getElementById('liveChange')?.textContent||'').trim(),
        sync:(document.getElementById('syncStatus')?.textContent||'').trim()
      }
    }));
    await page.screenshot({path:`${out}/${String(idx).padStart(2,'0')}-${name}-1d.png`,fullPage:true});

    await page.evaluate(()=>{if(typeof setChartRange==='function')setChartRange('price','1m');});
    await page.waitForTimeout(450);
    const month=await page.evaluate(()=>({
      range:typeof priceRange==='undefined'?null:priceRange,
      points:(ivChart?.data?.datasets?.[0]?.data||[]).length,
      overflow:document.documentElement.scrollWidth-window.innerWidth
    }));
    await page.screenshot({path:`${out}/${String(idx).padStart(2,'0')}-${name}-1m.png`,fullPage:true});
    await page.evaluate(()=>{if(typeof setChartRange==='function')setChartRange('price','1d');});
    await page.waitForTimeout(250);

    return {name,snap,month,consoleErrors,pageErrors};
  }finally{
    page.off('console',onConsole);page.off('pageerror',onPageError);
  }
}

function ms(v){const n=Date.parse(v||'');return Number.isFinite(n)?n:null;}
function checkMonotone(curr,prev){
  if(!prev)return [];
  const e=[];
  for(const k of ['usLast','deLast','dailyLast','sentimentLast']){
    const a=ms(curr.data[k]),b=ms(prev.data[k]);
    if(a!=null&&b!=null&&a<b)e.push(k+' moved backwards: '+curr.data[k]+' < '+prev.data[k]);
  }
  for(const k of ['usMinutes','deMinutes','daily','sentimentHistory']){
    const a=Number(curr.data[k]||0),b=Number(prev.data[k]||0);
    if(b>=20&&a<b*.9)e.push(k+' dropped '+b+' -> '+a);
    if(a===0&&b>0)e.push(k+' dropped to zero');
  }
  return e;
}

for(let i=0;i<iterations;i++){
  const sampled=[];
  for(const s of sessions){
    try{sampled.push(await sampleSession(s,i));}
    catch(e){sampled.push({name:s.name,error:String(e?.stack||e)});}
  }
  const server=await fetch('https://alantu-market-production.up.railway.app/health',{cache:'no-store'}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)})).catch(e=>({error:String(e)}));
  const row={iteration:i+1,at:new Date().toISOString(),server,sessions:sampled};
  const desktop=sampled.find(x=>x.name==='desktop'&&x.snap)?.snap;
  const errs=[];
  for(const x of sampled){
    if(x.error){errs.push(x.error);continue;}
    if(x.consoleErrors?.length)errs.push(x.name+' console '+JSON.stringify(x.consoleErrors));
    if(x.pageErrors?.length)errs.push(x.name+' page '+JSON.stringify(x.pageErrors));
    if(x.snap.overflow>4||x.month.overflow>4)errs.push(x.name+' horizontal overflow');
    if(!x.snap.priceAxis||x.snap.priceAxis.minBerlin!=='08:00'||x.snap.priceAxis.maxBerlin!=='22:00')errs.push(x.name+' day axis '+JSON.stringify(x.snap.priceAxis));
    if(!x.snap.scrub.active||!x.snap.scrub.point)errs.push(x.name+' scrub inactive');
    if(x.month.range!=='1m'||x.month.points<10)errs.push(x.name+' month invalid '+JSON.stringify(x.month));
    if(x.snap.data.usMinutes===0||x.snap.data.deMinutes===0||x.snap.data.daily===0)errs.push(x.name+' core data zero '+JSON.stringify(x.snap.data));
  }
  if(server.status!==200||server.body?.ok!==true)errs.push('server health '+JSON.stringify(server));
  if(desktop&&previous)errs.push(...checkMonotone(desktop,previous));
  if(desktop)previous=desktop;
  row.errors=errs;hardErrors.push(...errs.map(e=>'#'+(i+1)+' '+e));rows.push(row);
  await fs.writeFile(`${out}/samples.json`,JSON.stringify(rows,null,2));
  if(i<iterations-1)await new Promise(r=>setTimeout(r,intervalMs));
}

const summary={
  started_at:rows[0]?.at||null,
  finished_at:rows[rows.length-1]?.at||null,
  iterations:rows.length,
  interval_minutes:intervalMs/60000,
  screenshots:rows.length*configs.length*2,
  ok:hardErrors.length===0,
  errors:[...new Set(hardErrors)]
};
await fs.writeFile(`${out}/summary.json`,JSON.stringify(summary,null,2));
await fs.writeFile(`${out}/SUMMARY.md`,[
  '# ALANTU 3h Live Monitor',
  '',
  `- Samples: ${summary.iterations}`,
  `- Interval: ${summary.interval_minutes} min`,
  `- Screenshots: ${summary.screenshots}`,
  `- Result: ${summary.ok?'PASS':'FAIL'}`,
  '',
  summary.errors.length?'## Findings\n'+summary.errors.map(x=>'- '+x).join('\n'):'No consistency regressions detected.'
].join('\n'));
console.log(JSON.stringify(summary,null,2));
await browser.close();
if(!summary.ok)process.exitCode=1;
