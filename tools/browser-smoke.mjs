import { chromium } from 'playwright';

const url=process.env.SMOKE_URL||'https://www.alantu.de/';
const out=process.env.SMOKE_OUT||'/tmp/alantu-browser-smoke';
const fs=await import('node:fs/promises');
await fs.mkdir(out,{recursive:true});

async function run(name,viewport){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewportSize:viewport});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400)httpErrors.push({status:r.status(),url:r.url()});});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(5000);
  const priceCanvas=page.locator('#ivChart');
  await priceCanvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const priceBox=await priceCanvas.boundingBox();
  if(!priceBox)throw new Error('price chart has no bounding box');

  const hoverX=priceBox.x+priceBox.width*.62, hoverY=priceBox.y+priceBox.height*.48;
  let cdp=null;
  if(viewport.width<=700){
    cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:hoverX,y:hoverY}]});
    await page.waitForTimeout(650);
    for(const frac of [.66,.72,.78]){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:priceBox.x+priceBox.width*frac,y:hoverY}]});
      await page.waitForTimeout(120);
    }
  }else{
    await page.mouse.move(hoverX,hoverY);
    await page.waitForTimeout(350);
    await page.mouse.move(priceBox.x+priceBox.width*.76,hoverY);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1000);
  const interactionState=await page.evaluate(()=>({
    priceTooltipActive:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?((ivChart.tooltip._active||[]).length):0,
    priceTooltipOpacity:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?Number(ivChart.tooltip.opacity||0):0,
    scrubActive:typeof priceScrubState!=='undefined'&&!!priceScrubState.active,
    scrubPoint:typeof priceScrubState!=='undefined'&&priceScrubState.point?{x:Number(priceScrubState.point.x),y:Number(priceScrubState.point.y)}:null,
    scrubSource:typeof priceScrubState!=='undefined'?priceScrubState.source:null
  }));
  await page.screenshot({path:`${out}/${name}-1d.png`,fullPage:true});
  if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});

  const wgoCard=page.locator('#wgoCard');
  if(await wgoCard.count())await wgoCard.evaluate(el=>{el.open=true;});
  const wgoButton=page.locator('#wgoRun');
  if(await wgoButton.count()){
    await wgoButton.click();
    await page.waitForFunction(()=>{
      const b=document.getElementById('wgoRun');
      return b && !b.disabled;
    },null,{timeout:15000}).catch(()=>{});
  }
  const wgoState=await page.evaluate(()=>({
    answer:(document.getElementById('wgoAnswer')?.textContent||'').trim(),
    meta:(document.getElementById('wgoMeta')?.textContent||'').trim(),
    disabled:!!document.getElementById('wgoRun')?.disabled,
    liveChange:(document.getElementById('liveChange')?.textContent||'').trim(),
    open:!!document.getElementById('wgoCard')?.open,
    ranges:Array.from(document.querySelectorAll('#wgoWindow [data-wgo-range]')).map(x=>x.getAttribute('data-wgo-range')),
    hasFiveMinute:!!document.querySelector('#wgoWindow [data-wgo-minutes="5"]'),
    cacheMs:typeof WGO_CACHE_MS==='number'?WGO_CACHE_MS:null
  }));
  await page.locator('#wgoWindow [data-wgo-range="1m"]').click();
  await page.waitForTimeout(450);
  const wgoMonthState=await page.evaluate(()=>({
    answer:(document.getElementById('wgoAnswer')?.textContent||'').trim(),
    meta:(document.getElementById('wgoMeta')?.textContent||'').trim(),
    range:typeof wgoRange==='undefined'?null:wgoRange,
    priceRange:typeof priceRange==='undefined'?null:priceRange
  }));

  const state=await page.evaluate(()=>{
    let renderForecastError=null;
    try{ if(typeof renderForecastTrail==='function') renderForecastTrail(); }catch(e){ renderForecastError=String(e?.stack||e); }
    const ids=['modelDecision','hypothesisDecision','v5Research','forecastProof','forecastProofStrip','marketFlow'];
    const boxes=Object.fromEntries(ids.map(id=>{
      const el=document.getElementById(id),r=el?.getBoundingClientRect(),cs=el?getComputedStyle(el):null;
      const closedDetails=el?.closest?.('details:not([open])');
      const visible=!!r&&r.width>0&&r.height>0&&!(closedDetails&&closedDetails!==el);
      return [id,{exists:!!el,visible,width:r?.width||0,height:r?.height||0,text:(el?.textContent||'').trim().slice(0,500),
        html:(el?.innerHTML||'').slice(0,1200),display:cs?.display||null,visibility:cs?.visibility||null,opacity:cs?.opacity||null}];
    }));
    const st=typeof shadowTrailState!=='undefined'?shadowTrailState:null;
    return {
      title:document.title,
      ready:document.readyState,
      width:{inner:window.innerWidth,scroll:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth-window.innerWidth},
      boxes,renderForecastError,
      shadowTrail:{present:!!st,version:st?.version||null,outcomes:Array.isArray(st?.outcomes)?st.outcomes.length:null,pending:Array.isArray(st?.pending)?st.pending.length:null,
        outcome0:Array.isArray(st?.outcomes)&&st.outcomes.length?st.outcomes[0]:null,pending0:Array.isArray(st?.pending)&&st.pending.length?st.pending[0]:null},
      chartEvents:typeof chartEvents==='function'?chartEvents():null,
      priceTooltipActive:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?((ivChart.tooltip._active||[]).length):0,
      priceTooltipOpacity:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?Number(ivChart.tooltip.opacity||0):0,
      priceAxis:(typeof ivChart!=='undefined'&&ivChart&&ivChart.scales&&ivChart.scales.x)?{
        min:ivChart.scales.x.min,max:ivChart.scales.x.max,
        minBerlin:new Date(ivChart.scales.x.min).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'}),
        maxBerlin:new Date(ivChart.scales.x.max).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'})
      }:null,
      forecastCollapsed:document.getElementById('forecastProof')?.open===false,
      modelDecisionText:(document.getElementById('modelDecision')?.textContent||'').trim(),
      bodyText:(document.body?.innerText||'').slice(0,4000)
    };
  });
  await page.locator('button[data-price-range="1m"]').click();
  await page.waitForTimeout(900);
  const monthState=await page.evaluate(()=>({
    range:typeof priceRange==='undefined'?null:priceRange,
    points:typeof ivChart==='undefined'||!ivChart?0:(ivChart.data?.datasets?.[0]?.data||[]).length,
    overflow:document.documentElement.scrollWidth-window.innerWidth
  }));
  await page.screenshot({path:`${out}/${name}-1m.png`,fullPage:true});
  await page.locator('button[data-price-range="1d"]').click();
  await page.waitForTimeout(400);

  const allowedHttp=httpErrors.filter(x=>!x.url.includes('favicon'));
  const errors=[];
  const required=['modelDecision','forecastProof'];
  const badMarkers=required.map(k=>[k,state.boxes[k]]).filter(([,v])=>!v||!v.exists||!v.visible);
  const hiddenResearch=['hypothesisDecision','v5Research','forecastProofStrip'].filter(k=>state.boxes[k]&&state.boxes[k].visible);
  if(state.renderForecastError)errors.push('forecast-render:'+state.renderForecastError);
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(allowedHttp.length)errors.push('http:'+JSON.stringify(allowedHttp));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(badMarkers.length)errors.push('hidden:'+JSON.stringify(badMarkers));
  if(hiddenResearch.length)errors.push('research-visible-while-collapsed:'+JSON.stringify(hiddenResearch));
  if(state.width.overflow>4)errors.push('horizontal-overflow:'+state.width.overflow);
  if(!Array.isArray(state.chartEvents)||!state.chartEvents.includes('mousemove')||!state.chartEvents.includes('touchmove'))errors.push('chart-events-missing:'+JSON.stringify(state.chartEvents));
  if(!interactionState.scrubActive||!interactionState.scrubPoint||!Number.isFinite(interactionState.scrubPoint.y))errors.push('price-scrub-not-active:'+JSON.stringify(interactionState));
  if(!state.priceAxis||state.priceAxis.minBerlin!=='08:00'||state.priceAxis.maxBerlin!=='22:00')errors.push('day-axis-not-08-22:'+JSON.stringify(state.priceAxis));
  if(monthState.range!=='1m'||monthState.points<10)errors.push('month-range-invalid:'+JSON.stringify(monthState));
  if(monthState.overflow>4)errors.push('month-horizontal-overflow:'+monthState.overflow);
  if(wgoState.disabled||/nicht erreichbar|Frontend-Abbruch/i.test(wgoState.answer+' '+wgoState.meta)||!wgoState.answer)errors.push('wgo-live-failed:'+JSON.stringify(wgoState));
  if(!wgoState.open)errors.push('wgo-not-openable:'+JSON.stringify(wgoState));
  if(wgoState.hasFiveMinute)errors.push('wgo-five-minute-still-present');
  if(wgoState.cacheMs!==600000)errors.push('wgo-cache-not-10m:'+wgoState.cacheMs);
  if(JSON.stringify(wgoState.ranges)!==JSON.stringify(['current','1d','1w','1m','year','5y','all']))errors.push('wgo-ranges-wrong:'+JSON.stringify(wgoState.ranges));
  if(wgoMonthState.range!=='1m'||wgoMonthState.priceRange!=='1m'||!/1M:/i.test(wgoMonthState.answer))errors.push('wgo-month-summary-not-chart-aligned:'+JSON.stringify(wgoMonthState));
  if(!/heute|Tageskontext|Tagesmove/i.test(wgoState.answer+' '+wgoState.meta))errors.push('wgo-day-context-missing:'+JSON.stringify(wgoState));
  const dayPctMatch=wgoState.answer.match(/Tagesbasis bei\s+([+-]?\d+(?:\.\d+)?)\s*%/i);
  if(dayPctMatch&&Number(dayPctMatch[1])<=-1&&!/stärkste\s+\d+-Minuten-Abverkauf\s+heute/i.test(wgoState.answer))errors.push('wgo-intraday-selloff-missing:'+JSON.stringify(wgoState));
  if(/Im selben Zeitraum wurde keine neue relevante Oracle-Meldung erfasst/i.test(wgoState.answer))errors.push('wgo-old-window-only-copy:'+JSON.stringify(wgoState));
  if(/Heute[^.]{0,120}(?:bei|Tagesbasis bei)\s*-\d/i.test(wgoState.answer)&&!/Abverkauf|Rückgang|gefallen/i.test(wgoState.answer))errors.push('wgo-negative-day-without-selloff:'+JSON.stringify(wgoState));
  const uiPctMatch=wgoState.liveChange.replaceAll(',','.').match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  const briefPctMatch=wgoState.answer.replaceAll(',','.').match(/Heute liegt ORCL[^.]{0,160}?([+-]\d+(?:\.\d+)?)\s*%/i);
  if(uiPctMatch&&briefPctMatch){
    const uiPct=Number(uiPctMatch[1]),briefPct=Number(briefPctMatch[1]);
    if(Number.isFinite(uiPct)&&Number.isFinite(briefPct)&&Math.abs(uiPct-briefPct)>.45)errors.push('wgo-day-percent-mismatch:'+JSON.stringify({uiPct,briefPct,wgoState}));
  }
  if(!state.bodyText.includes('Prognosen vs. Realität'))errors.push('forecast-label-missing');
  if(!state.modelDecisionText.includes('MODELLSTATUS:'))errors.push('model-status-text-missing');
  if(!state.forecastCollapsed)errors.push('forecast-not-collapsed-by-default');
  if(!/MODELLSTATUS: (KAUFSIGNAL|KEIN KAUFSIGNAL|VERKAUFSSIGNAL)/.test(state.modelDecisionText))errors.push('model-decision-missing');

  console.log(JSON.stringify({name,url,state,interactionState,monthState,wgoState,wgoMonthState,consoleErrors,pageErrors,httpErrors:allowedHttp,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(name+' smoke failed: '+errors.join(' | '));
}

await run('desktop',{width:1440,height:1200});
await run('mobile',{width:390,height:844});
console.log('ALANTU_BROWSER_SMOKE_OK');
