import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';

// Minimal canvas/document shim so createAlantuCoverCanvas runs in Node.
const fills=[];
let currentFont='16px sans-serif';
let fontPx=16;

function parseFontPx(font){
  const m=String(font).match(/(\d+(?:\.\d+)?)px/);
  return m?Number(m[1]):16;
}

// Conservative serif advance: slightly wide so overflow bugs still fail.
function measureWidth(text){
  const chars=[...String(text)];
  let w=0;
  for(const ch of chars){
    if(ch===' ')w+=fontPx*.33;
    else if(/[iltjfI1.,;:'!]/.test(ch))w+=fontPx*.35;
    else if(/[mwMW]/.test(ch))w+=fontPx*.85;
    else w+=fontPx*.62;
  }
  return w;
}

const ctx={
  fillStyle:'#000',
  textBaseline:'alphabetic',
  get font(){return currentFont;},
  set font(v){currentFont=String(v);fontPx=parseFontPx(currentFont);},
  fillRect(){},
  measureText(text){return {width:measureWidth(text)};},
  fillText(text,x,y,maxWidth){
    fills.push({
      text:String(text),
      x,
      y,
      maxWidth:maxWidth===undefined?null:maxWidth,
      fontPx,
      measured:measureWidth(text)
    });
  }
};

globalThis.document={
  createElement(tag){
    assert.equal(tag,'canvas');
    return {
      width:0,
      height:0,
      getContext(type){
        assert.equal(type,'2d');
        return ctx;
      }
    };
  }
};

const coreUrl=pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname),'../alantu-book-core.js')).href;
const {createAlantuCoverCanvas,sanitizeAlantuCoverTitle}=await import(coreUrl);

function runCover(title,width=1800,height=2400){
  fills.length=0;
  createAlantuCoverCanvas({title,width,height});
  const pad=Math.round(width*.105);
  const usable=width-pad*2;
  const titleTop=Math.round(height*.15);
  const titleBottom=Math.round(height*.79);
  const brand=fills[0];
  const subtitle=fills[fills.length-1];
  const titleFills=fills.slice(1,-1);
  return {pad,usable,titleTop,titleBottom,brand,subtitle,titleFills,fills:[...fills]};
}

// 1) Long German compound word must hard-break (never a single measured line > usable).
{
  const title='Eigentumswohnungsverkaufsvorbereitungsunterlagen München-Schwabing';
  const {usable,titleFills,titleTop,titleBottom,pad}=runCover(title);
  assert.ok(titleFills.length>=1&&titleFills.length<=3,`expected 1–3 title lines, got ${titleFills.length}`);
  for(const line of titleFills){
    assert.equal(line.x,pad);
    assert.equal(line.maxWidth,usable,'fillText must pass usable as maxWidth belt');
    assert.ok(line.measured<=usable+0.5,`line wider than usable: "${line.text}" (${line.measured}>${usable})`);
    // Baseline within band with ascent/descent slack matching createAlantuCoverCanvas metrics.
    const ascent=Math.round(line.fontPx*.8);
    const descent=Math.round(line.fontPx*.25);
    assert.ok(line.y-ascent>=titleTop-1,`title top overflow y=${line.y} font=${line.fontPx}`);
    assert.ok(line.y+descent<=titleBottom+1,`title bottom overflow y=${line.y} font=${line.fontPx}`);
  }
  assert.match(sanitizeAlantuCoverTitle(title),/Eigentumswohnungsverkaufsvorbereitungsunterlagen/);
}

// 2) Multi-word long title still clamps vertically and stays ≤3 lines.
{
  const title='Exklusive Dachgeschossmaisonette mit weitläufiger Dachterrasse und Blick über die Alpen in Garmisch-Partenkirchen';
  const {usable,titleFills,titleTop,titleBottom}=runCover(title);
  assert.ok(titleFills.length<=3,`too many lines: ${titleFills.length}`);
  const first=titleFills[0];
  const last=titleFills[titleFills.length-1];
  const ascent=Math.round(first.fontPx*.8);
  const descent=Math.round(last.fontPx*.25);
  assert.ok(first.y-ascent>=titleTop-1);
  assert.ok(last.y+descent<=titleBottom+1);
  for(const line of titleFills){
    assert.ok(line.measured<=usable+0.5);
    assert.equal(line.maxWidth,usable);
  }
}

// 3) Short title still renders and keeps maxWidth belt.
{
  const {titleFills,usable}=runCover('Villa am See');
  assert.equal(titleFills.length,1);
  assert.equal(titleFills[0].maxWidth,usable);
  assert.ok(titleFills[0].measured<=usable);
}

console.log('COVER_TITLE_LAYOUT_OK',JSON.stringify({
  compoundLines:runCover('Eigentumswohnungsverkaufsvorbereitungsunterlagen München-Schwabing').titleFills.map(l=>l.text),
  longLines:runCover('Exklusive Dachgeschossmaisonette mit weitläufiger Dachterrasse und Blick über die Alpen in Garmisch-Partenkirchen').titleFills.map(l=>l.text)
}));
