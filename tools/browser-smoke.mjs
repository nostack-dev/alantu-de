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
  // Passive hover must stay clean. Readout appears only while pressing/dragging.
  if(viewport.width>700){
    await page.mouse.move(hoverX,hoverY);
    await page.waitForTimeout(250);
    const hoverOnly=await page.evaluate(()=>typeof priceScrubState!=='undefined'&&!!priceScrubState.active);
    if(hoverOnly)throw new Error('price scrub activated on passive hover');
    await page.mouse.down();
    await page.mouse.move(priceBox.x+priceBox.width*.76,hoverY);
    await page.waitForTimeout(250);
  }else{
    cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:hoverX,y:hoverY}]});
    await page.waitForTimeout(180);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:priceBox.x+priceBox.width*.76,y:hoverY}]});
    await page.waitForTimeout(180);
  }
  const interactionState=await page.evaluate(()=>({
    priceTooltipActive:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?((ivChart.tooltip._active||[]).length):0,
    priceTooltipOpacity:(typeof ivChart!=='undefined'&&ivChart&&ivChart.tooltip)?Number(ivChart.tooltip.opacity||0):0,
    scrubActive:typeof priceScrubState!=='undefined'&&!!priceScrubState.active,
    scrubPoint:typeof priceScrubState!=='undefined'&&priceScrubState.point?{x:Number(priceScrubState.point.x),y:Number(priceScrubState.point.y)}:null,
    scrubSource:typeof priceScrubState!=='undefined'?priceScrubState.source:null,
    priceAxis:(typeof ivChart!=='undefined'&&ivChart&&ivChart.scales&&ivChart.scales.x)?{
      min:ivChart.scales.x.min,max:ivChart.scales.x.max,
      minBerlin:new Date(ivChart.scales.x.min).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'}),
      maxBerlin:new Date(ivChart.scales.x.max).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'})
    }:null
  }));
  const projectionTarget=await page.evaluate(()=>{
    if(typeof ivChart==='undefined'||!ivChart)return null;
    const sets=ivChart.data?.datasets||[],price=sets.find(d=>d.label==='Kurs'),proj=sets.find(d=>d.label==='Projektionspfad');
    const hint=document.getElementById('projectionHint'),pp=price?.data||[],pj=proj?.data||[];
    const last=pp.length?Number(pp[pp.length-1].x):NaN;
    const future=pj.filter(p=>Number(p.x)>last+1000);
    if(!future.length)return {available:false,hintVisible:!!hint&&!hint.hidden,style:proj?{borderColor:proj.borderColor,borderDash:proj.borderDash,borderWidth:proj.borderWidth}:null};
    const p=future[future.length-1],box=document.getElementById('ivChart').getBoundingClientRect();
    return {available:true,hintVisible:!!hint&&!hint.hidden,clientX:box.left+ivChart.scales.x.getPixelForValue(Number(p.x)),clientY:box.top+ivChart.scales.y.getPixelForValue(Number(p.y)),x:Number(p.x),y:Number(p.y),style:{borderColor:proj.borderColor,borderDash:proj.borderDash,borderWidth:proj.borderWidth}};
  });
  let projectionInteraction=null;
  if(projectionTarget?.available){
    if(viewport.width<=700){
      if(!cdp)cdp=await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:projectionTarget.clientX-10,y:projectionTarget.clientY}]});
      await page.waitForTimeout(260);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:projectionTarget.clientX,y:projectionTarget.clientY}]});
      await page.waitForTimeout(220);
    }else{
      await page.mouse.up().catch(()=>{});
      await page.mouse.move(projectionTarget.clientX,projectionTarget.clientY);
      await page.waitForTimeout(120);
      const hoverOnly=await page.evaluate(()=>typeof priceScrubState!=='undefined'&&!!priceScrubState.active);
      if(hoverOnly)throw new Error('projection scrub activated on passive hover');
      await page.mouse.down();
      await page.waitForTimeout(180);
    }
    projectionInteraction=await page.evaluate(()=>({
      active:typeof priceScrubState!=='undefined'&&!!priceScrubState.active,
      kind:typeof priceScrubState!=='undefined'&&priceScrubState.point?priceScrubState.point.kind:null,
      point:typeof priceScrubState!=='undefined'&&priceScrubState.point?priceScrubState.point:null
    }));
  }
  await page.screenshot({path:`${out}/${name}-1d.png`,fullPage:true});
  if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}).catch(()=>{});
  else await page.mouse.up().catch(()=>{});

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
  await page.waitForFunction(()=>{
    const a=(document.getElementById('wgoAnswer')?.textContent||'').trim();
    const b=document.getElementById('wgoRun');
    return b && !b.disabled && /^1M:/i.test(a) && /Hintergrund 1M:/i.test(a);
  },null,{timeout:20000}).catch(()=>{});
  const wgoMonthState=await page.evaluate(()=>({
    answer:(document.getElementById('wgoAnswer')?.textContent||'').trim(),
    meta:(document.getElementById('wgoMeta')?.textContent||'').trim(),
    range:typeof wgoRange==='undefined'?null:wgoRange,
    priceRange:typeof priceRange==='undefined'?null:priceRange
  }));

  const sourceStateUi=await page.evaluate(()=>({
    live:typeof liveSourceState!=='undefined'?liveSourceState:null,
    status:(document.getElementById('sentimentPanelStatus')?.textContent||'').trim(),
    counts:(document.getElementById('sentimentSourceCounts')?.textContent||'').trim(),
    freshItems:(document.getElementById('freshItems')?.textContent||'').trim(),
    freshAt:(document.getElementById('freshAt')?.textContent||'').trim(),
    redditRows:document.querySelectorAll('[data-source-kind="reddit"]').length,
    xText:(document.getElementById('sentimentSourceCounts')?.textContent||'').trim(),
    sourceFeatureContract:(()=>{try{const f=typeof getMarketWaveVector==='function'?getMarketWaveVector():{};return {model_eligible:f?.sourceFeature?.model_eligible,direction:f?.sourceFeature?.direction,status:f?.sourceFeature?.status,hasSourceDir:Object.prototype.hasOwnProperty.call(f||{},'sourceDir'),hasCrowdDir:Object.prototype.hasOwnProperty.call(f||{},'crowdDir'),hasMassDir:Object.prototype.hasOwnProperty.call(f||{},'massDir')};}catch(e){return {error:String(e)}}})(),
    compactNumber:(document.getElementById('sentimentCompactNumber')?.textContent||'').trim(),
    compactLabel:(document.getElementById('sentimentCompactLabel')?.textContent||'').trim()
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
  const dayContract=await page.evaluate(()=>{
    const v=valueSeries(),de=(orclGermanyBars||[]).filter(x=>Number.isFinite(new Date(x.at||0).getTime()));
    return {source:v.source,rows:v.priceRows.length,lastAt:v.priceRows.length?new Date(v.priceRows[v.priceRows.length-1].at).getTime():null,germanLastAt:de.length?new Date(de[de.length-1].at).getTime():null};
  });
  const rangeStates={};
  for(const range of ['1w','1m','year','5y','all']){
    await page.locator(`button[data-price-range="${range}"]`).click();
    await page.waitForTimeout(650);
    rangeStates[range]=await page.evaluate(()=>{
      const v=valueSeries(),raw=priceRange==='1w'?filterByAt(orclMinuteBars||[],h=>h.at,priceRange):filterByAt(orclDailyBars||[],h=>h.at,priceRange);
      const convertible=raw.filter(h=>Number.isFinite(usdToEur(h.close,h.at))&&usdToEur(h.close,h.at)>0).length;
      const pts=(ivChart?.data?.datasets?.find(d=>d.label==='Kurs')?.data||[]),xs=pts.map(p=>Number(p.x)).filter(Number.isFinite).sort((a,b)=>a-b),ys=pts.map(p=>Number(p.y)).filter(Number.isFinite);
      return {range:priceRange,source:v.source,points:pts.length,sourceRows:v.priceRows.length,rawRows:raw.length,convertible,coverage:raw.length?convertible/raw.length:0,finitePositive:pts.length>0&&ys.length===pts.length&&ys.every(y=>y>0),spanDays:xs.length>1?(xs.at(-1)-xs[0])/864e5:0,xMin:ivChart?.scales?.x?.min??null,xMax:ivChart?.scales?.x?.max??null,yMin:ivChart?.scales?.y?.min??null,yMax:ivChart?.scales?.y?.max??null,overflow:document.documentElement.scrollWidth-window.innerWidth};
    });
    if(range==='1m')await page.screenshot({path:`${out}/${name}-1m.png`,fullPage:true});
  }
  const monthState=rangeStates['1m'];
  const secondaryStates={sentiment:{},magnitude:{},forecast:{},opinions:{}};
  for(const range of ['1d','1w','1m','year','5y','all']){
    for(const kind of ['sentiment','magnitude']){
      await page.evaluate(({kind,range})=>setChartRange(kind,range),{kind,range});await page.waitForTimeout(120);
      secondaryStates[kind][range]=await page.evaluate((kind)=>{const chart=kind==='sentiment'?hypeChart:magChart,selected=kind==='sentiment'?sentimentRange:magnitudeRange,pts=(chart?.data?.datasets?.[0]?.data||[]);return {range:selected,exists:!!chart,points:pts.length,xMin:chart?.scales?.x?.min??null,xMax:chart?.scales?.x?.max??null,yMin:chart?.scales?.y?.min??null,yMax:chart?.scales?.y?.max??null};},kind);
    }
    await page.evaluate(r=>setChartRange('forecast',r),range);await page.waitForTimeout(80);
    secondaryStates.forecast[range]=await page.evaluate(()=>({range:forecastRange,invalid:/\b(?:NaN|undefined)\b/.test(document.getElementById('forecastProofStrip')?.textContent||'')}));
    await page.evaluate(r=>setChartRange('opinions',r),range);await page.waitForTimeout(80);
    secondaryStates.opinions[range]=await page.evaluate(()=>({range:opinionsRange,exists:!!pieChart,data:(pieChart?.data?.datasets?.[0]?.data||[]).map(Number)}));
  }
  await page.locator('button[data-price-range="1d"]').click();
  await page.waitForTimeout(400);

  await page.evaluate(()=>{
    ['alantu_price_range_v1','alantu_forecast_range_v1','alantu_sentiment_range_v1','alantu_magnitude_range_v1','alantu_opinions_range_v1'].forEach(k=>localStorage.setItem(k,'BROKEN_RANGE'));
    localStorage.setItem('alantu_chart_open_v1','{broken-json');
    localStorage.setItem('alantu_intrinsic_visible_v1','0');
  });
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(3500);
  const storageSanitized=await page.evaluate(()=>({
    priceRange:typeof priceRange==='undefined'?null:priceRange,
    forecastRange:typeof forecastRange==='undefined'?null:forecastRange,
    sentimentRange:typeof sentimentRange==='undefined'?null:sentimentRange,
    magnitudeRange:typeof magnitudeRange==='undefined'?null:magnitudeRange,
    opinionsRange:typeof opinionsRange==='undefined'?null:opinionsRange,
    storedRanges:{price:localStorage.getItem('alantu_price_range_v1'),forecast:localStorage.getItem('alantu_forecast_range_v1'),sentiment:localStorage.getItem('alantu_sentiment_range_v1'),magnitude:localStorage.getItem('alantu_magnitude_range_v1'),opinions:localStorage.getItem('alantu_opinions_range_v1')},
    chartOpenRaw:localStorage.getItem('alantu_chart_open_v1'),
    showIntrinsic:typeof showIntrinsic==='undefined'?null:showIntrinsic,
    pressed:document.getElementById('intrinsicToggle')?.getAttribute('aria-pressed'),
    active:document.getElementById('intrinsicToggle')?.classList.contains('active'),
    intrinsicHidden:(ivChart?.data?.datasets||[]).find(d=>d.label==='Innerer Wert')?.hidden
  }));
  await page.locator('#intrinsicToggle').click();
  await page.waitForTimeout(250);
  const storageImmediate=await page.evaluate(()=>({
    showIntrinsic:typeof showIntrinsic==='undefined'?null:showIntrinsic,
    stored:localStorage.getItem('alantu_intrinsic_visible_v1'),
    pressed:document.getElementById('intrinsicToggle')?.getAttribute('aria-pressed'),
    active:document.getElementById('intrinsicToggle')?.classList.contains('active'),
    intrinsicHidden:(ivChart?.data?.datasets||[]).find(d=>d.label==='Innerer Wert')?.hidden
  }));
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(3000);
  const storageReloaded=await page.evaluate(()=>({
    showIntrinsic:typeof showIntrinsic==='undefined'?null:showIntrinsic,
    stored:localStorage.getItem('alantu_intrinsic_visible_v1'),
    pressed:document.getElementById('intrinsicToggle')?.getAttribute('aria-pressed'),
    active:document.getElementById('intrinsicToggle')?.classList.contains('active'),
    intrinsicHidden:(ivChart?.data?.datasets||[]).find(d=>d.label==='Innerer Wert')?.hidden
  }));

  const allowedHttp=httpErrors.filter(x=>!x.url.includes('favicon'));
  const allowedFailed=failed.filter(x=>!String(x.error||'').includes('ERR_ABORTED'));
  const errors=[];
  const required=['modelDecision','forecastProof'];
  const badMarkers=required.map(k=>[k,state.boxes[k]]).filter(([,v])=>!v||!v.exists||!v.visible);
  const hiddenResearch=['hypothesisDecision','v5Research','forecastProofStrip'].filter(k=>state.boxes[k]&&state.boxes[k].visible);
  if(state.renderForecastError)errors.push('forecast-render:'+state.renderForecastError);
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(allowedHttp.length)errors.push('http:'+JSON.stringify(allowedHttp));
  if(allowedFailed.length)errors.push('requestfailed:'+JSON.stringify(allowedFailed));
  if(badMarkers.length)errors.push('hidden:'+JSON.stringify(badMarkers));
  if(hiddenResearch.length)errors.push('research-visible-while-collapsed:'+JSON.stringify(hiddenResearch));
  if(state.width.overflow>4)errors.push('horizontal-overflow:'+state.width.overflow);
  if(!Array.isArray(state.chartEvents)||state.chartEvents.includes('mousemove')||!state.chartEvents.includes('touchmove'))errors.push('chart-events-not-press-only:'+JSON.stringify(state.chartEvents));
  if(!interactionState.scrubActive||!interactionState.scrubPoint||!Number.isFinite(interactionState.scrubPoint.y))errors.push('price-press-readout-not-active:'+JSON.stringify(interactionState));
  if(projectionTarget){
    if(projectionTarget.hintVisible)errors.push('projection-permanent-readout-visible:'+JSON.stringify(projectionTarget));
    if(!projectionTarget.style||!Array.isArray(projectionTarget.style.borderDash)||projectionTarget.style.borderDash.length<2||Number(projectionTarget.style.borderWidth)<2.4)errors.push('projection-style-too-subtle:'+JSON.stringify(projectionTarget));
    if(projectionTarget.available&&(!projectionInteraction||!projectionInteraction.active||projectionInteraction.kind!=='projection'))errors.push('projection-scrub-not-active:'+JSON.stringify({projectionTarget,projectionInteraction}));
  }
  if(!interactionState.priceAxis||interactionState.priceAxis.minBerlin!=='08:00'||interactionState.priceAxis.maxBerlin!=='22:00')errors.push('day-axis-not-08-22:'+JSON.stringify(interactionState.priceAxis));
  if(storageSanitized.priceRange!=='1d'||storageSanitized.forecastRange!=='1d'||storageSanitized.sentimentRange!=='1m'||storageSanitized.magnitudeRange!=='1m'||storageSanitized.opinionsRange!=='1m'||JSON.stringify(storageSanitized.storedRanges)!==JSON.stringify({price:'1d',forecast:'1d',sentiment:'1m',magnitude:'1m',opinions:'1m'})||storageSanitized.chartOpenRaw!=='{}')errors.push('local-storage-sanitize-failed:'+JSON.stringify(storageSanitized));
  if(storageSanitized.showIntrinsic!==false||storageSanitized.pressed!=='false'||storageSanitized.active!==false||storageSanitized.intrinsicHidden!==true)errors.push('intrinsic-storage-load-failed:'+JSON.stringify(storageSanitized));
  if(storageImmediate.showIntrinsic!==true||storageImmediate.stored!=='1'||storageImmediate.pressed!=='true'||storageImmediate.active!==true||storageImmediate.intrinsicHidden!==false)errors.push('intrinsic-toggle-needs-reload:'+JSON.stringify(storageImmediate));
  if(storageReloaded.showIntrinsic!==true||storageReloaded.stored!=='1'||storageReloaded.pressed!=='true'||storageReloaded.active!==true||storageReloaded.intrinsicHidden!==false)errors.push('intrinsic-toggle-persistence-failed:'+JSON.stringify(storageReloaded));
  if(dayContract.source==='germany_eur'&&Number.isFinite(dayContract.germanLastAt)&&dayContract.lastAt>dayContract.germanLastAt+1000)errors.push('day-chart-mixed-venues:'+JSON.stringify(dayContract));
  const minRangePoints={ '1w':20, '1m':10, year:50, '5y':200, all:500 },minSpanDays={ '1w':3, '1m':20, year:300, '5y':1460, all:2920 },expectedSource={ '1w':'us_orcl_fx_minute','1m':'us_orcl_fx_daily',year:'us_orcl_fx_daily','5y':'us_orcl_fx_daily',all:'us_orcl_fx_daily' };
  for(const [range,rs] of Object.entries(rangeStates)){
    const finiteAxes=[rs.xMin,rs.xMax,rs.yMin,rs.yMax].every(Number.isFinite);
    if(rs.range!==range||rs.source!==expectedSource[range]||rs.points<(minRangePoints[range]||2)||rs.sourceRows<(minRangePoints[range]||2)||rs.rawRows<(minRangePoints[range]||2)||rs.coverage<.999||!rs.finitePositive||rs.spanDays<(minSpanDays[range]||0)||!finiteAxes||!(rs.xMax>rs.xMin)||!(rs.yMax>rs.yMin)||rs.yMin<0)errors.push('price-range-invalid-'+range+':'+JSON.stringify(rs));
    if(rs.overflow>4)errors.push('price-range-horizontal-overflow-'+range+':'+rs.overflow);
  }
  for(const kind of ['sentiment','magnitude'])for(const [range,rs] of Object.entries(secondaryStates[kind])){const axes=[rs.xMin,rs.xMax,rs.yMin,rs.yMax];if(rs.range!==range||!rs.exists||rs.points<1||!axes.every(Number.isFinite)||!(rs.xMax>rs.xMin)||!(rs.yMax>rs.yMin))errors.push(kind+'-range-invalid-'+range+':'+JSON.stringify(rs));}
  for(const [range,rs] of Object.entries(secondaryStates.forecast))if(rs.range!==range||rs.invalid)errors.push('forecast-range-invalid-'+range+':'+JSON.stringify(rs));
  for(const [range,rs] of Object.entries(secondaryStates.opinions))if(rs.range!==range||!rs.exists||rs.data.length!==3||!rs.data.every(Number.isFinite)||rs.data.some(v=>v<0))errors.push('opinions-range-invalid-'+range+':'+JSON.stringify(rs));
  if(wgoState.disabled||/nicht erreichbar|Frontend-Abbruch/i.test(wgoState.answer+' '+wgoState.meta)||!wgoState.answer)errors.push('wgo-live-failed:'+JSON.stringify(wgoState));
  if(!wgoState.open)errors.push('wgo-not-openable:'+JSON.stringify(wgoState));
  if(wgoState.hasFiveMinute)errors.push('wgo-five-minute-still-present');
  if(wgoState.cacheMs!==600000)errors.push('wgo-cache-not-10m:'+wgoState.cacheMs);
  if(JSON.stringify(wgoState.ranges)!==JSON.stringify(['current','1d','1w','1m','year','5y','all']))errors.push('wgo-ranges-wrong:'+JSON.stringify(wgoState.ranges));
  if(wgoMonthState.range!=='1m'||wgoMonthState.priceRange!=='1m'||!/1M:/i.test(wgoMonthState.answer)||!/Hintergrund 1M:/i.test(wgoMonthState.answer))errors.push('wgo-month-summary-not-chart-aligned:'+JSON.stringify(wgoMonthState));
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
  if(sourceStateUi.live){
    const age=Date.now()-Date.parse(sourceStateUi.live.checked_at||'');
    if(!Number.isFinite(age)||age>180000)errors.push('source-state-not-fresh:'+JSON.stringify(sourceStateUi));
    if(Number(sourceStateUi.live.archive_count||0)>0&&Number(sourceStateUi.freshItems)!==Number(sourceStateUi.live.archive_count))errors.push('source-archive-count-not-primary:'+JSON.stringify(sourceStateUi));
    if(sourceStateUi.live.contract!=='source-event-v3'||sourceStateUi.live.role!=='raw_observation_only')errors.push('source-contract-not-v3:'+JSON.stringify(sourceStateUi.live));
    if(sourceStateUi.live.interpretation_status!=='unvalidated_not_used')errors.push('source-interpretation-status-invalid:'+JSON.stringify(sourceStateUi.live));
    for(const k of ['score','bull','bear','mixed','net','archive_sentiment','live_pulse'])if(Object.prototype.hasOwnProperty.call(sourceStateUi.live,k))errors.push('directional-source-field-leaked:'+k);
    if(sourceStateUi.live.activity?.model_eligible!==false||sourceStateUi.live.activity?.direction!==null)errors.push('source-activity-not-fail-closed:'+JSON.stringify(sourceStateUi.live.activity));
    if(Object.prototype.hasOwnProperty.call(sourceStateUi.live.social_aggregates?.reddit||{},'sentiment_pct'))errors.push('source-aggregate-sentiment-leaked');
    const sf=sourceStateUi.sourceFeatureContract||{};
    if(sf.model_eligible!==false||sf.direction!==null||sf.status!=='unvalidated_not_used'||sf.hasSourceDir||sf.hasCrowdDir||sf.hasMassDir)errors.push('wave-source-feature-not-fail-closed:'+JSON.stringify(sf));
    if((sourceStateUi.live.items||[]).some(x=>Object.prototype.hasOwnProperty.call(x,'lean')))errors.push('source-item-lean-leaked');
    if(sourceStateUi.live.event_clock!=='first_seen_at')errors.push('source-event-clock-not-first-seen:'+JSON.stringify(sourceStateUi.live));
    if((sourceStateUi.live.items||[]).some(x=>!x.first_seen_at))errors.push('source-item-missing-first-seen');
    if(sourceStateUi.live.social_aggregates?.reddit&&Object.prototype.hasOwnProperty.call(sourceStateUi.live.social_aggregates.reddit,'sentiment_pct'))errors.push('vendor-sentiment-leaked');
    if(Number(sourceStateUi.live.archive_count||0)>0&&Number(sourceStateUi.compactNumber)!==Number(sourceStateUi.live.archive_count))errors.push('source-activity-ui-count-mismatch:'+JSON.stringify(sourceStateUi));
    if(/\/100|positiv|negativ|bullisch|bearisch/i.test(sourceStateUi.compactLabel))errors.push('source-ui-directional-language:'+JSON.stringify(sourceStateUi));
    const irrelevant=(sourceStateUi.live.items||[]).filter(x=>/oracle academy|university workshop|oracle financial services/i.test(String(x.title||'')));
    if(irrelevant.length)errors.push('irrelevant-oracle-source:'+JSON.stringify(irrelevant.slice(0,3)));
    const redditArchive=Number(sourceStateUi.live.archive_source_counts?.reddit||0);
    if(redditArchive>0&&sourceStateUi.redditRows<1)errors.push('reddit-archive-not-visible:'+JSON.stringify(sourceStateUi));
    if(sourceStateUi.live.source_health?.x?.status==='disabled'&&!/X\s*nicht verbunden/i.test(sourceStateUi.counts))errors.push('x-disabled-not-explicit:'+JSON.stringify(sourceStateUi));
  }
  const sourceDirectionContract=await page.evaluate(()=>({legacySentimentWave:typeof sentimentWave==='function',legacyApply:typeof applyRailwaySentiment==='function',rawFeature:typeof sourceDirectionalFeature==='function'}));
  if(sourceDirectionContract.legacySentimentWave||sourceDirectionContract.legacyApply||!sourceDirectionContract.rawFeature)errors.push('frontend-source-direction-contract:'+JSON.stringify(sourceDirectionContract));
  const obsoleteStableRef=await page.evaluate(()=>document.documentElement.innerHTML.includes('stableDayYBounds('));
  if(obsoleteStableRef)errors.push('stable-day-y-bounds-reference');
  if(!state.bodyText.includes('Prognosen vs. Realität'))errors.push('forecast-label-missing');
  if(!state.modelDecisionText.includes('MODELLSTATUS:'))errors.push('model-status-text-missing');
  if(!state.forecastCollapsed)errors.push('forecast-not-collapsed-by-default');
  if(!/MODELLSTATUS: (KAUFSIGNAL|KEIN KAUFSIGNAL|VERKAUFSSIGNAL)/.test(state.modelDecisionText))errors.push('model-decision-missing');

  console.log(JSON.stringify({name,url,state,interactionState,projectionTarget,projectionInteraction,dayContract,rangeStates,secondaryStates,monthState,wgoState,wgoMonthState,storageSanitized,storageImmediate,storageReloaded,consoleErrors,pageErrors,httpErrors:allowedHttp,failed:allowedFailed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(name+' smoke failed: '+errors.join(' | '));
}

await run('desktop',{width:1440,height:1200});
await run('mobile',{width:390,height:844});
console.log('ALANTU_BROWSER_SMOKE_OK');
