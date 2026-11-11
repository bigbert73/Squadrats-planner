/* extras.js: what was added on top of the planner in index.html.
 *
 *   – the installation's own name, the installed app and offline use
 *   – walking and running profiles (pace, length range)
 *   – weather and wind on the route, loops planned into the wind
 *   – a link to a route, a route from somebody's GPX file
 *   – imports from StatsHunters and VeloViewer
 *   – forgotten password, changing the e-mail address
 *   – spoken turn-by-turn while riding
 *
 * Loaded after the inline script of index.html and working on its globals
 * (routeCoords, _routeMeta, wpts, map, currentUser, …). index.html calls in
 * through optional hooks (window.onRouteUI?.() and friends), so the planner
 * keeps working if this file fails to load.
 *
 * Texts: plain Polish strings put into the page are translated by i18n.js on
 * their own; texts with numbers go through say(pl,en,{…}).
 */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const fill=(s,o)=>o?s.replace(/\{(\w+)\}/g,(m,k)=>o[k]??m):s;
const say=(pl,en,o)=>fill(window.tl?tl(pl,en):pl,o);
const lang=()=>window.LANG||'pl';
const dec=(x,d=1)=>{const s=x.toFixed(d);return lang()==='en'?s:s.replace('.',',');};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const lsGet=k=>{try{return localStorage.getItem(k);}catch(_){return null;}};
const lsSet=(k,val)=>{try{localStorage.setItem(k,val);}catch(_){}};
const jpost=(url,body,method='POST')=>fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
async function okJson(r){
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`);
  return d;
}
function brg(a,b){
  const r=Math.PI/180,y=Math.sin((b.lng-a.lng)*r)*Math.cos(b.lat*r),
    x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lng-a.lng)*r);
  return (Math.atan2(y,x)/r+360)%360;
}
const angd=(a,b)=>((a-b+540)%360)-180; // a−b, in (−180,180]

// ═══════════════════════════════════════════════════════════════════════
//  NAME OF THIS INSTALLATION (APP_NAME on the server)
// ═══════════════════════════════════════════════════════════════════════
window.applyAppName=function(name){
  if(!name||typeof name!=='string') return;
  window.APP_NAME=name;
  document.title=name;
  document.querySelectorAll('[data-app-name]').forEach(e=>{e.classList.add('notranslate');e.textContent=name;});
};
fetch('/api/auth/providers').then(r=>r.ok?r.json():null).then(p=>{if(p) window.applyAppName(p.appName);}).catch(()=>{});

// ═══════════════════════════════════════════════════════════════════════
//  WALKING AND RUNNING: own pace and own length range
// ═══════════════════════════════════════════════════════════════════════
const PACE={bike:20,foot:5,run:10};
const classOf=p=>p==='foot'||p==='run'?p:'bike';
let _cls=classOf(typeof bikeProfile==='string'?bikeProfile:'');
let _pace={};
try{_pace=JSON.parse(lsGet('sq-pace')||'{}')||{};}catch(_){_pace={};}
window.onProfileSet=function(p){
  const c=classOf(p);
  if(c===_cls) return;
  const sp=$('avg-speed'), r=$('dist-r'), wasBike=_cls==='bike';
  _cls=c;
  sp.value=_pace[c]||PACE[c];
  if(c==='bike'){r.min=5;r.max=200;r.step=5;r.value=50;}
  else if(wasBike){r.min=3;r.max=60;r.step=1;r.value=c==='run'?10:8;}
  $('dist-lbl').textContent=r.value+' km';
  refreshRouteUI();
};
window.onSpeedInput=function(){
  const x=parseFloat($('avg-speed').value);
  if(x>=2&&x<=60){_pace[_cls]=x;lsSet('sq-pace',JSON.stringify(_pace));}
};

// ═══════════════════════════════════════════════════════════════════════
//  A ROUTE THAT COMES FROM OUTSIDE: a shared link or somebody's GPX file
// ═══════════════════════════════════════════════════════════════════════
let _named=null; // {coords,name}: the name such a route arrived with, offered when saving
window.planName=()=>_named&&_named.coords===routeCoords?_named.name:null;

// pts: [{lat,lng,elev}]. Shown like a planned route; "Zapisz" keeps it.
async function loadRouteAsPlan(name,pts,o={}){
  resetRoute();
  const a=pts[0], b=pts[pts.length-1];
  const loop=o.loop??(pts.length>10&&haversine(a,b)<0.2);
  const radio=document.querySelector(`input[name="loop"][value="${loop?'loop':'ab'}"]`);
  if(radio&&!radio.checked){radio.checked=true;radio.onchange?.();}
  if(o.profile&&/^[\w-]+$/.test(o.profile)){
    const btn=document.querySelector(`.bp-btn[onclick*="'${o.profile}'"]`);
    if(btn) setBikeProf(o.profile,btn);
  }
  addWpt(L.latLng(a.lat,a.lng),'start');
  if(!loop) addWpt(L.latLng(b.lat,b.lng),'end');
  relabelWpts(); renderWL(); if(rLine){map.removeLayer(rLine);rLine=null;}
  await showRoute({geometry:{coordinates:pts.map(p=>[p.lng,p.lat,p.elev||0])},distance:compDist(pts)*1000,
    elevProfile:null,surfaceProfile:null,hints:null},{loop});
  _named={coords:routeCoords,name};
}

// /?shared=<token> comes from the public page of a link ("Otwórz w planerze").
// Kept across signing in, which may leave the page for Strava and back.
const SHARED_KEY='sq-shared';
try{
  const q=new URLSearchParams(location.search), tok=q.get('shared');
  if(tok){
    if(/^[A-Za-z0-9_-]{8,64}$/.test(tok)) sessionStorage.setItem(SHARED_KEY,tok);
    q.delete('shared');
    const rest=q.toString();
    history.replaceState({},'',location.pathname+(rest?'?'+rest:'')+location.hash);
  }
}catch(_){}
async function openShared(token){
  showLoad('Wczytuję udostępnioną trasę…');
  try{
    const d=await okJson(await fetch('/api/shared/'+encodeURIComponent(token)));
    const pts=d.coords.map(([lat,lng,elev])=>({lat,lng,elev:elev||0}));
    await loadRouteAsPlan(d.name,pts,{loop:!!d.loop&&!d.trimmed_m,profile:d.profile});
    toast(say('Wczytano: {name}. Zapisz ją, jeśli chcesz ją mieć w „Moje trasy”.','Loaded: {name}. Save it to keep it in "My routes".',{name:d.name}));
  }catch(e){hideLoad();toast(say('Nie udało się wczytać trasy z linku: {err}','Could not load the route from the link: {err}',{err:e.message}));}
}

window.importRouteGPX=async function(ev){
  const f=ev.target.files&&ev.target.files[0];
  ev.target.value='';
  if(f) await importRouteFile(f);
};
async function importRouteFile(f){
  if(f.size>40e6){toast('Plik jest za duży (limit 40 MB)');return;}
  let doc;
  try{doc=new DOMParser().parseFromString(await f.text(),'application/xml');}catch(_){doc=null;}
  if(!doc||doc.getElementsByTagName('parsererror').length){toast('To nie jest poprawny plik GPX');return;}
  const tag=(root,n)=>[...root.getElementsByTagNameNS('*',n)];
  let nodes=tag(doc,'trkpt');
  if(nodes.length<2) nodes=tag(doc,'rtept');
  let pts=nodes.map(n=>{
    const e=tag(n,'ele')[0];
    return {lat:parseFloat(n.getAttribute('lat')),lng:parseFloat(n.getAttribute('lon')),elev:e?parseFloat(e.textContent)||0:0};
  }).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=85&&Math.abs(p.lng)<=180);
  if(pts.length<2){toast('W tym pliku GPX nie ma trasy (śladu ani punktów trasy)');return;}
  const MAX=20000; // a recorded ride has a point every second; the planner needs far fewer
  if(pts.length>MAX){
    const step=pts.length/MAX, thin=[];
    for(let i=0;i<MAX-1;i++) thin.push(pts[Math.floor(i*step)]);
    thin.push(pts[pts.length-1]);
    pts=thin;
  }
  const nm=n=>(n&&tag(n,'name')[0]?.textContent||'').trim();
  const name=(nm(tag(doc,'trk')[0])||nm(tag(doc,'rte')[0])||nm(tag(doc,'metadata')[0])||f.name.replace(/\.gpx$/i,'')).slice(0,120);
  closeRoutes();
  showLoad('Wczytuję trasę z pliku…');
  try{
    await loadRouteAsPlan(name,pts);
    toast(say('Wczytano z pliku: {name} · {km} km. Zapisz ją, jeśli chcesz ją mieć w „Moje trasy”.','Loaded from file: {name} · {km} km. Save it to keep it in "My routes".',{name,km:dec(_planKm)}));
  }catch(e){hideLoad();toast(say('Nie udało się wczytać trasy z pliku: {err}','Could not load the route from the file: {err}',{err:e.message}));}
}
window.importRouteFile=importRouteFile;

// ═══════════════════════════════════════════════════════════════════════
//  LINK TO A SAVED ROUTE ("Moje trasy" → Link)
// ═══════════════════════════════════════════════════════════════════════
const HIDE_TXT='Ukryj początek i koniec trasy (po 300 m), żeby link nie zdradzał, gdzie mieszkasz';
window.toggleSharePanel=function(r,card){
  const old=card.querySelector('.rt-share');
  if(old){old.remove();return;}
  const box=document.createElement('div');
  box.className='rt-share';
  card.querySelector('.rt-acts').after(box);
  renderShare(box,r,card);
};
function renderShare(box,r,card){
  const mark=()=>card.querySelector('.lnk')?.classList.toggle('on',!!r.share_token);
  const fail=e=>toast(say('Nie udało się zmienić udostępniania: {err}','Could not change sharing: {err}',{err:e.message}));
  if(!r.share_token){
    box.innerHTML=`<div>Każdy, kto dostanie link, zobaczy tę trasę na mapie i pobierze ją jako GPX. Nie zobaczy Twoich kwadratów, innych tras ani konta.</div>
      <label><input type="checkbox" class="hide" checked><span>${HIDE_TXT}</span></label>
      <div class="row"><button type="button" class="pri mk"><i class="ti ti-link"></i>Utwórz link</button></div>`;
    box.querySelector('.mk').onclick=async e=>{
      e.currentTarget.disabled=true;
      try{
        const d=await okJson(await jpost(`/api/routes/${r.id}/share`,{hideEnds:box.querySelector('.hide').checked}));
        r.share_token=d.token; r.share_trim_m=d.trim_m; mark(); renderShare(box,r,card);
      }catch(err){fail(err);e.currentTarget.disabled=false;}
    };
    return;
  }
  const url=location.origin+'/s/'+r.share_token;
  box.innerHTML=`<div class="row"><input type="text" readonly class="notranslate url">
      <button type="button" class="pri cp"><i class="ti ti-copy"></i>Kopiuj</button>
      ${navigator.share?'<button type="button" class="sh"><i class="ti ti-share"></i>Wyślij</button>':''}</div>
    <label><input type="checkbox" class="hide"${r.share_trim_m?' checked':''}><span>${HIDE_TXT}</span></label>
    <div class="row"><a class="pv" target="_blank" rel="noopener">Zobacz, co widzi odbiorca</a><button type="button" class="off"><i class="ti ti-link-off"></i>Wyłącz link</button></div>`;
  const inp=box.querySelector('.url');
  inp.value=url; inp.onfocus=()=>inp.select();
  box.querySelector('.pv').href=url;
  box.querySelector('.cp').onclick=async()=>{
    try{await navigator.clipboard.writeText(url);}
    catch(_){inp.focus();inp.select();try{document.execCommand('copy');}catch(__){}}
    toast('Skopiowano link do trasy');
  };
  const sh=box.querySelector('.sh');
  if(sh) sh.onclick=()=>navigator.share({title:r.name,url}).catch(()=>{});
  box.querySelector('.hide').onchange=async e=>{
    try{
      const d=await okJson(await jpost(`/api/routes/${r.id}/share`,{hideEnds:e.target.checked}));
      r.share_trim_m=d.trim_m;
      toast(d.trim_m?'Link ukrywa teraz początek i koniec trasy':'Link pokazuje teraz całą trasę');
    }catch(err){e.target.checked=!e.target.checked;fail(err);}
  };
  box.querySelector('.off').onclick=async()=>{
    try{
      await okJson(await fetch(`/api/routes/${r.id}/share`,{method:'DELETE'}));
      r.share_token=null; r.share_trim_m=0; mark(); renderShare(box,r,card);
      toast('Link wyłączony. Kto go ma, już nie otworzy trasy.');
    }catch(err){fail(err);}
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  IMPORTS: StatsHunters (share link), VeloViewer (KML with tiles)
// ═══════════════════════════════════════════════════════════════════════
window.toggleSHForm=function(){
  const f=$('sh-form');
  f.hidden=!f.hidden;
  if(!f.hidden) $('sh-link').focus();
};
window.importStatsHunters=async function(){
  const link=$('sh-link').value.trim();
  if(!link){toast('Wklej link udostępniania ze StatsHunters');return;}
  showLoad('Pobieram kwadraty ze StatsHunters…');
  try{
    const d=await okJson(await jpost('/api/import/statshunters',{link}));
    await loadTilesFromDB();
    toast(d.addedSQ
      ? say('StatsHunters: +{n} nowych SQ ({a} aktywności) · łącznie {t} SQ','StatsHunters: +{n} new SQ ({a} activities) · {t} SQ in total',{n:d.addedSQ,a:d.activities,t:d.totalSQ})
      : say('StatsHunters: brak nowych kwadratów, masz już wszystkie {p} (łącznie {t} SQ)','StatsHunters: no new squares, you already have all {p} ({t} SQ in total)',{p:d.parsedSQ,t:d.totalSQ}));
    $('sh-form').hidden=true; $('sh-link').value='';
  }catch(e){toast(say('Import ze StatsHunters nie powiódł się: {err}','The StatsHunters import failed: {err}',{err:e.message}));}
  finally{hideLoad();}
};
window.importVeloViewerKML=async function(ev){
  const f=ev.target.files&&ev.target.files[0];
  ev.target.value='';
  if(!f) return;
  if(f.size>30e6){toast('Plik jest za duży (limit 30 MB)');return;}
  showLoad('Importuję kafelki z VeloViewer…');
  try{
    const d=await okJson(await fetch('/api/import/veloviewer-kml',{method:'POST',headers:{'Content-Type':'text/plain'},body:await f.text()}));
    await loadTilesFromDB();
    toast(d.addedSQ
      ? say('VeloViewer: +{n} nowych SQ · łącznie {t} SQ','VeloViewer: +{n} new SQ · {t} SQ in total',{n:d.addedSQ,t:d.totalSQ})
      : say('VeloViewer: brak nowych kwadratów, masz już wszystkie {p} (łącznie {t} SQ)','VeloViewer: no new squares, you already have all {p} ({t} SQ in total)',{p:d.parsedSQ,t:d.totalSQ}));
  }catch(e){toast(say('Import z VeloViewer nie powiódł się: {err}','The VeloViewer import failed: {err}',{err:e.message}));}
  finally{hideLoad();}
};

// ═══════════════════════════════════════════════════════════════════════
//  WEATHER AND WIND ON THE ROUTE (forecast: MET Norway, through our server)
// ═══════════════════════════════════════════════════════════════════════
const WX={cache:new Map(),start:null,sig:'',timer:null,seq:0,windFrom:null};
const CALM=3; // m/s; below that the wind decides nothing
function forecastAt(p){
  const k=p.lat.toFixed(1)+','+p.lng.toFixed(1), c=WX.cache.get(k);
  if(c&&Date.now()-c.at<30*60e3) return c.p;
  const pr=fetch(`/api/weather?lat=${p.lat.toFixed(3)}&lng=${p.lng.toFixed(3)}`).then(okJson).then(d=>{
    d.hours.forEach(h=>{h.ms=Date.parse(h.t);});
    return d;
  });
  WX.cache.set(k,{at:Date.now(),p:pr});
  pr.catch(()=>WX.cache.delete(k));
  return pr;
}
function hourAt(fc,ms){
  let best=fc.hours[0];
  for(const h of fc.hours){if(h.ms<=ms) best=h; else break;}
  return best;
}
const startMs=()=>WX.start&&WX.start>Date.now()?WX.start:Date.now();
const WIND_FROM=[['z północy','from the north'],['z północnego wschodu','from the north-east'],['ze wschodu','from the east'],['z południowego wschodu','from the south-east'],
  ['z południa','from the south'],['z południowego zachodu','from the south-west'],['z zachodu','from the west'],['z północnego zachodu','from the north-west']];
const windName=d=>{const w=WIND_FROM[Math.round(d/45)%8];return say(w[0],w[1]);};
function wxIcon(sym){
  const s=String(sym||'');
  if(/thunder/.test(s)) return 'ti-cloud-storm';
  if(/snow|sleet/.test(s)) return 'ti-cloud-snow';
  if(/rain|drizzle/.test(s)) return 'ti-cloud-rain';
  if(/fog/.test(s)) return 'ti-mist';
  if(/^cloudy/.test(s)) return 'ti-cloud';
  if(/partlycloudy|fair/.test(s)) return /night/.test(s)?'ti-cloud':'ti-sun-wind';
  if(/clearsky/.test(s)) return /night/.test(s)?'ti-moon':'ti-sun';
  return 'ti-cloud';
}
// Called whenever the route card is redrawn; the forecast itself is fetched
// only when the route, the pace or the start hour changed.
window.onRouteUI=function(){
  clearTimeout(WX.timer);
  WX.timer=setTimeout(refreshWx,400);
};
async function refreshWx(force){
  const box=$('rc-wx');
  if(!box) return;
  const coords=routeCoords;
  if(!coords||coords.length<2||!currentUser){box.hidden=true;WX.sig='';return;}
  const speed=clamp(parseFloat($('avg-speed').value)||20,2,60);
  const sig=[coords.length,coords[0].lat,coords[coords.length-1].lng,speed,WX.start,lang()].join('|');
  if(!force&&sig===WX.sig&&WX.coords===coords) return;
  const seq=++WX.seq;
  const cum=routeCum(), total=cum[cum.length-1];
  if(!(total>0)){box.hidden=true;return;}
  const at=f=>{let i=0;while(i<cum.length-1&&cum[i]<f*total)i++;return coords[i];};
  let fcs;
  try{fcs=await Promise.all([0,.25,.5,.75].map(f=>forecastAt(at(f))));}
  catch(e){
    if(seq!==WX.seq) return;
    WX.sig=''; box.hidden=false; box.className='rc-wx notranslate';
    box.innerHTML=`<div class="wx-src"><i class="ti ti-cloud-off"></i> ${esc(say('Prognoza pogody jest teraz niedostępna','The weather forecast is unavailable right now'))}</div>`;
    return;
  }
  if(seq!==WX.seq||coords!==routeCoords) return;
  WX.sig=sig; WX.coords=coords;

  // walk the route in ~200 m steps: where the rider heads, when they get there, what blows then
  const t0=startMs();
  let head=0,tail=0,cross=0,h1=0,h2=0,wSum=0,vx=0,vy=0,rain=0,tMin=Infinity,tMax=-Infinity,i0=0;
  for(let i=1;i<coords.length;i++){
    const len=cum[i]-cum[i0];
    if(len<0.2&&i<coords.length-1) continue;
    if(len>0){
      const mid=(cum[i0]+cum[i])/2, fc=fcs[clamp(Math.round(mid/total*4),0,3)];
      const h=hourAt(fc,t0+mid/speed*3600e3), w=h.wind||0, d=Math.abs(angd(brg(coords[i0],coords[i]),h.dir||0));
      if(d<60) head+=len; else if(d>120) tail+=len; else cross+=len;
      const comp=w*Math.cos(d*Math.PI/180)*len;
      if(mid<total/2) h1+=comp; else h2+=comp;
      wSum+=w*len;
      vx+=w*Math.sin((h.dir||0)*Math.PI/180)*len; vy+=w*Math.cos((h.dir||0)*Math.PI/180)*len;
      if(h.rain>rain) rain=h.rain;
      if(h.temp!=null){tMin=Math.min(tMin,h.temp);tMax=Math.max(tMax,h.temp);}
    }
    i0=i;
  }
  const wAvg=wSum/total, dir=(Math.atan2(vx,vy)*180/Math.PI+360)%360;
  const first=hourAt(fcs[0],t0);
  const closed=WX.coords===(_routeMeta&&_routeMeta.coords)?!!_routeMeta.loop:haversine(coords[0],coords[coords.length-1])<0.3;
  const diff=(h1-h2)/(total/2);            // mean headwind of the first half minus the second, m/s
  const verdict=!closed||wAvg<CALM?null:diff>=0.4*wAvg?'good':diff<=-0.4*wAvg?'bad':'side';
  WX.windFrom=wAvg>=CALM?dir:null;
  const canPlan=closed&&wpts.length===1; // a loop from just a start: the planner chooses where it goes

  // start hour: now, then every full hour for two days
  const now=new Date(), day0=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const opts=[`<option value="">${esc(say('start teraz','start now'))}</option>`];
  const firstH=Math.ceil((Date.now()+60e3)/3600e3)*3600e3;
  for(let k=0;k<47;k++){
    const ms=firstH+k*3600e3, dt=new Date(ms), dd=Math.floor((ms-day0)/864e5);
    const day=dd===0?say('dziś','today'):dd===1?say('jutro','tomorrow'):dt.toLocaleDateString(window.locale?locale():'pl-PL',{weekday:'short'});
    opts.push(`<option value="${ms}"${WX.start===ms?' selected':''}>${esc(day)} ${String(dt.getHours()).padStart(2,'0')}:00</option>`);
  }
  const pct=x=>Math.round(x/total*100);
  const temp=tMin===Infinity?'—':Math.round(tMin)===Math.round(tMax)?`${Math.round(tMin)}°C`:`${Math.round(tMin)}–${Math.round(tMax)}°C`;
  const kmh=Math.round(wAvg*3.6);
  let tip='';
  if(verdict==='good') tip=`<div class="wx-tip good"><i class="ti ti-thumb-up"></i><span>${esc(say('Najpierw pod wiatr, powrót z wiatrem.','Into the wind first, the wind at your back on the way home.'))}</span></div>`;
  else if(verdict){
    const txt=verdict==='bad'
      ? say('Najpierw z wiatrem, powrót pod wiatr.','Tailwind first, headwind on the way home.')
      : say('Wiatr głównie z boku.','Mostly a crosswind.');
    tip=`<div class="wx-tip"><span>${esc(txt)}${canPlan?' '+esc(say('Pętla po stronie, z której wieje, da powrót z wiatrem.','A loop on the side the wind comes from gives a tailwind home.')):''}</span>${canPlan?`<button type="button" onclick="planIntoWind()">${esc(say('Zaplanuj pod wiatr','Plan into the wind'))}</button>`:''}</div>`;
  }
  box.className='rc-wx notranslate';
  box.innerHTML=`<div class="wx-top"><i class="ti ${wxIcon(first.sym)}"></i><b>${temp}</b><select aria-label="${esc(say('Godzina startu','Start time'))}" onchange="setWxStart(this.value)">${opts.join('')}</select></div>
    <div class="wx-row"><span title="${esc(say('Średni wiatr na trasie','Mean wind along the route'))}"><i class="ti ti-wind"></i>${kmh} km/h <span class="wx-arrow" style="transform:rotate(${Math.round(dir+180)}deg)">↑</span> ${esc(wAvg<1?say('cisza','calm'):windName(dir))}</span>
      <span><i class="ti ti-droplet"></i>${esc(rain<0.1?say('bez opadów','no rain'):say('opad do {n} mm/h','rain up to {n} mm/h',{n:dec(rain)}))}</span></div>
    ${wAvg>=1?`<div class="wx-bar"><span class="h" style="width:${pct(head)}%"></span><span class="c" style="width:${pct(cross)}%"></span><span class="t" style="width:${pct(tail)}%"></span></div>
    <div class="wx-leg"><span class="h">${esc(say('pod wiatr {n}%','headwind {n}%',{n:pct(head)}))}</span><span>${esc(say('z boku {n}%','crosswind {n}%',{n:pct(cross)}))}</span><span class="t">${esc(say('z wiatrem {n}%','tailwind {n}%',{n:pct(tail)}))}</span></div>`:''}
    ${tip}
    <div class="wx-src">${esc(say('Prognoza: MET Norway','Forecast: MET Norway'))}</div>`;
  box.hidden=false;
  box.dataset.verdict=verdict||'';
  box.dataset.head=pct(head); box.dataset.tail=pct(tail); box.dataset.wind=kmh; box.dataset.dir=Math.round(dir);
}
window.setWxStart=function(val){
  WX.start=val?Number(val):null;
  refreshWx(true);
};
window.addEventListener('langchange',()=>{WX.sig='';window.onRouteUI();});

// "Pętla pod wiatr na początek": the planner is told where the wind comes
// from and only tries loops on that side of the start.
const windOpt=$('wind-loop');
if(windOpt) windOpt.checked=lsGet('sq-wind-loop')==='1';
window.onWindOpt=()=>lsSet('sq-wind-loop',windOpt.checked?'1':'0');
window.windForPlan=async function(start){
  if(!windOpt||!windOpt.checked||!start) return null;
  try{
    const h=hourAt(await forecastAt(start),startMs());
    if(!(h.wind>=CALM)){toast(say('Wiatr jest słaby ({n} km/h), więc kierunek pętli wybieram bez niego','The wind is light ({n} km/h), so it does not decide where the loop goes',{n:Math.round((h.wind||0)*3.6)}));return null;}
    return h.dir;
  }catch(_){toast('Nie mam prognozy wiatru, planuję pętlę bez niej');return null;}
};
window.planIntoWind=function(){
  if(!windOpt) return;
  windOpt.checked=true; window.onWindOpt();
  calcRoute();
};

// ═══════════════════════════════════════════════════════════════════════
//  ACCOUNT: forgotten password, new password from the e-mailed link, e-mail
// ═══════════════════════════════════════════════════════════════════════
let _resetTok=null;
function takeResetLink(){
  try{
    const m=/^#reset=([A-Za-z0-9_-]{16,200})$/.exec(location.hash);
    if(!m) return false;
    _resetTok=m[1];
    history.replaceState({},'',location.pathname+location.search); // the token must not stay in the address bar or history
    return true;
  }catch(_){return false;}
}
takeResetLink();
// the link opened in a tab where the app is already open: no page load happens
window.addEventListener('hashchange',()=>{if(takeResetLink()) showReset();});
const _swTab=window.swAuthTab;
window.swAuthTab=function(t){
  _swTab(t);
  const side=t==='forgot'||t==='reset';
  document.querySelectorAll('.auth-tabs,#strava-first,#social-section').forEach(e=>e.classList.toggle('auth-side-hide',side));
  if(t!=='reset'&&_resetTok){
    _resetTok=null;
    if(currentUser) $('auth-gate').style.display='none'; // the form was shown over the app of somebody signed in
  }
};
function showReset(){
  $('auth-gate').style.display='flex';
  $('reset-err').textContent='';
  const tok=_resetTok;
  window.swAuthTab('reset');
  _resetTok=tok;
  setTimeout(()=>$('reset-pass').focus(),50);
}
window.onAuthGate=function(){if(_resetTok) showReset();};
window.doForgot=async function(e){
  e.preventDefault();
  const err=$('forgot-err'), ok=$('forgot-ok'), btn=e.target.querySelector('.auth-submit');
  err.textContent=''; ok.hidden=true; btn.disabled=true;
  try{
    await okJson(await jpost('/api/auth/forgot',{email:$('forgot-email').value.trim(),lang:lang()}));
    ok.textContent='Jeśli jest konto z tym adresem, wysłaliśmy na niego link do ustawienia nowego hasła. Link działa godzinę. Zajrzyj też do spamu.';
    ok.hidden=false;
  }catch(ex){err.textContent=ex.message;}
  finally{btn.disabled=false;}
};
window.doReset=async function(e){
  e.preventDefault();
  const err=$('reset-err'), p1=$('reset-pass').value, p2=$('reset-pass2').value;
  err.textContent='';
  if(p1!==p2){err.textContent='Hasła nie są zgodne';return;}
  const btn=e.target.querySelector('.auth-submit');
  btn.disabled=true;
  try{
    const d=await okJson(await jpost('/api/auth/reset',{token:_resetTok,password:p1}));
    _resetTok=null;
    $('reset-pass').value=$('reset-pass2').value='';
    window.swAuthTab('login');
    currentUser=d.user;
    onAuthSuccess();
    toast('Hasło zmienione. Jesteś zalogowany.');
  }catch(ex){err.textContent=ex.message;}
  finally{btn.disabled=false;}
};

window.editEmail=function(){
  const box=$('prof-email-box');
  if(box.innerHTML){box.innerHTML='';return;}
  const needPass=!!currentUser.has_password;
  box.innerHTML=`<label>Nowy adres e-mail</label><input id="prof-email-new" type="email" maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false">
    ${needPass?'<label>Obecne hasło</label><input id="prof-email-pass" type="password" autocomplete="current-password">':''}
    <div class="hint" style="text-align:left;margin:4px 0 0">Na ten adres wyślemy link, gdy zapomnisz hasła.</div>
    <div id="prof-email-err" style="font-size:10px;color:var(--red);margin-top:4px;min-height:14px"></div>
    <button class="btn btn-b" style="margin-top:6px" onclick="saveEmail()"><i class="ti ti-mail"></i>Zapisz adres</button>`;
  $('prof-email-new').value=currentUser.email||'';
  $('prof-email-new').focus();
};
window.saveEmail=async function(){
  const err=$('prof-email-err');
  err.textContent='';
  try{
    const d=await okJson(await jpost('/api/profile/email',{email:$('prof-email-new').value.trim(),current_password:$('prof-email-pass')?.value||undefined},'PUT'));
    currentUser=d.user;
    $('prof-email').textContent=currentUser.email||'—';
    $('prof-email-box').innerHTML='';
    toast('Zapisano adres e-mail');
  }catch(e){err.textContent=e.message;}
};

// ═══════════════════════════════════════════════════════════════════════
//  INSTALLED APP AND OFFLINE USE
// ═══════════════════════════════════════════════════════════════════════
// The service worker (sw.js) keeps the app itself, the last answers of a few
// read-only API calls and the map tiles that were looked at. It needs https.
const swOK='serviceWorker' in navigator&&window.isSecureContext;
if(swOK) navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('service worker:',e.message));

let _installEvt=null;
const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function syncInstall(){
  const b=$('install-btn');
  if(b) b.style.display=!standalone()&&(_installEvt||(isIOS()&&swOK))?'':'none';
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();_installEvt=e;syncInstall();});
window.addEventListener('appinstalled',()=>{_installEvt=null;syncInstall();});
window.installApp=async function(){
  if(_installEvt){
    const e=_installEvt; _installEvt=null;
    try{await e.prompt();}catch(_){}
    syncInstall();
    return;
  }
  // iPhone and iPad have no install prompt: the way leads through the share sheet
  let h=$('install-hint');
  if(h){h.remove();return;}
  h=document.createElement('div');
  h.id='install-hint';
  h.innerHTML=`<button type="button" aria-label="Zamknij" onclick="this.parentNode.remove()"><i class="ti ti-x"></i></button>
    <b>Dodaj aplikację do ekranu początkowego</b><br>W Safari dotknij <i class="ti ti-share-2"></i> <b>Udostępnij</b>, a potem <b>Do ekranu początkowego</b>. Aplikacja otworzy się wtedy na pełnym ekranie i zadziała także bez zasięgu.`;
  document.body.appendChild(h);
};
syncInstall();

function syncOnline(){const p=$('offline-pill');if(p) p.hidden=navigator.onLine!==false;}
window.addEventListener('online',syncOnline);
window.addEventListener('offline',syncOnline);
syncOnline();

// Saved routes are opened on the road, often without coverage: fetch the
// newest ones once so the service worker has them.
const _kept=new Set();
window.onRoutesLoaded=function(routes){
  if(!swOK||!navigator.serviceWorker.controller||navigator.onLine===false||navigator.connection?.saveData) return;
  const ids=(routes||[]).slice(0,15).map(r=>r.id).filter(id=>!_kept.has(id));
  ids.forEach(id=>_kept.add(id));
  (async()=>{
    for(const id of ids){
      try{await fetch('/api/routes/'+id);}catch(_){return;}
      await new Promise(r=>setTimeout(r,300));
    }
  })();
};
window.onLogout=function(){
  try{navigator.serviceWorker?.controller?.postMessage({type:'clear-api'});}catch(_){}
  try{sessionStorage.removeItem(SHARED_KEY);}catch(_){}
};

// ═══════════════════════════════════════════════════════════════════════
//  SPOKEN TURNS WHILE RIDING
// ═══════════════════════════════════════════════════════════════════════
// Turns come from BRouter (hints saved with the route) and, for a route
// without them (drawn by hand, from a file, a shared one), from its shape.
const TURN={
  l:['skręć w lewo','turn left','ti-corner-up-left'], r:['skręć w prawo','turn right','ti-corner-up-right'],
  sl:['lekko w lewo','bear left','ti-arrow-bear-left'], sr:['lekko w prawo','bear right','ti-arrow-bear-right'],
  hl:['ostro w lewo','sharp left','ti-arrow-sharp-turn-left'], hr:['ostro w prawo','sharp right','ti-arrow-sharp-turn-right'],
  kl:['trzymaj się lewej','keep left','ti-arrow-bear-left'], kr:['trzymaj się prawej','keep right','ti-arrow-bear-right'],
  u:['zawróć','make a U-turn','ti-arrow-back-up'], rb:['wjedź na rondo','enter the roundabout','ti-arrow-rotary-straight'],
};
const CMD_KIND={2:'l',3:'sl',4:'hl',5:'r',6:'sr',7:'hr'};
function turnKind(cmd,exit,ang){
  if(cmd===13||cmd===14) return {k:'rb',exit:exit||0};
  if(cmd===10||cmd===11||cmd===15) return {k:'u'};
  if(cmd===8) return {k:'kl'};
  if(cmd===9) return {k:'kr'};
  if(cmd===1||cmd===12||cmd===16) return null; // straight on, off route, beeline
  const a=Math.abs(ang||0), byAngle=a<20?null:(a<45?'s':a<=120?'':'h')+(ang<0?'l':'r');
  let k=CMD_KIND[cmd];
  if(!k||(a>=20&&k.endsWith('l')!==(ang<0))) k=byAngle; // the angle wins where the two disagree
  return k?{k}:null;
}
function pointAt(cum,km){
  const n=cum.length-1;
  if(km<=0) return routeCoords[0];
  if(km>=cum[n]) return routeCoords[n];
  let lo=0,hi=n;
  while(hi-lo>1){const m=(lo+hi)>>1; if(cum[m]<=km) lo=m; else hi=m;}
  const a=routeCoords[lo],b=routeCoords[hi],t=(km-cum[lo])/((cum[hi]-cum[lo])||1);
  return {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
}
function shapeTurns(cum){
  const W=0.025, n=routeCoords.length, found=[];
  for(let i=1;i<n-1;i++){
    if(cum[i]<W||cum[n-1]-cum[i]<W) continue;
    const p=routeCoords[i], d=angd(brg(p,pointAt(cum,cum[i]+W)),brg(pointAt(cum,cum[i]-W),p));
    if(Math.abs(d)<50) continue;
    const last=found[found.length-1];
    if(last&&cum[i]-last.km<0.04){if(Math.abs(d)>Math.abs(last.ang)){last.km=cum[i];last.ang=d;}continue;}
    found.push({km:cum[i],ang:d});
  }
  return found.map(t=>({km:t.km,...turnKind(0,0,t.ang)}));
}
function buildTurns(){
  if(!routeCoords||routeCoords.length<2) return [];
  const cum=routeCum(), hints=_routeMeta&&_routeMeta.coords===routeCoords?_routeMeta.hints:null;
  let turns;
  if(Array.isArray(hints)&&hints.length){
    turns=[];
    for(const h of hints){
      const k=turnKind(h[1],h[2],h[4]);
      if(k&&h[0]>0&&h[0]<cum.length) turns.push({km:cum[h[0]],...k});
    }
  }else turns=shapeTurns(cum);
  return turns.sort((a,b)=>a.km-b.km);
}
window.routeTurns=buildTurns;

let _nav=null;
let _voice=lsGet('sq-voice')!=='0';
const canSpeak='speechSynthesis' in window&&typeof SpeechSynthesisUtterance==='function';
window._spoken=[]; // the last things said (also what the tests listen to)
function speak(text){
  window._spoken.push(text);
  if(window._spoken.length>30) window._spoken.shift();
  if(!_voice||!canSpeak) return;
  try{
    const u=new SpeechSynthesisUtterance(text), loc=window.locale?locale():'pl-PL';
    u.lang=loc; u.rate=1.05;
    const vs=speechSynthesis.getVoices(), pre=loc.slice(0,2).toLowerCase();
    const vc=vs.find(x=>x.lang===loc)||vs.find(x=>x.lang&&x.lang.toLowerCase().startsWith(pre));
    if(vc) u.voice=vc;
    speechSynthesis.speak(u);
  }catch(_){}
}
function turnPhrase(t){
  if(t.k==='rb'&&t.exit>0) return say('na rondzie zjazd numer {n}','at the roundabout take exit {n}',{n:t.exit});
  return say(TURN[t.k][0],TURN[t.k][1]);
}
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
function syncVoiceBtn(){
  const b=$('ride-voice');
  if(!b) return;
  b.classList.toggle('mute',!_voice);
  b.innerHTML=`<i class="ti ti-volume${_voice?'':'-off'}"></i>`;
  b.title=_voice?'Komunikaty głosowe o skrętach: włączone':'Komunikaty głosowe o skrętach: wyłączone';
}
window.toggleVoice=function(){
  _voice=!_voice;
  lsSet('sq-voice',_voice?'1':'0');
  syncVoiceBtn();
  if(_voice) speak(say('Komunikaty głosowe włączone','Voice guidance on'));
  else try{speechSynthesis.cancel();}catch(_){}
};
syncVoiceBtn();
function showTurn(t,m,now){
  const el=$('ride-turn');
  if(!el) return;
  if(!t||m>5000){el.hidden=true;return;}
  el.hidden=false;
  el.className='notranslate'+(now?' now':'');
  const dist=m>=1000?dec(m/1000)+' km':Math.max(0,Math.round(m/10)*10)+' m';
  el.innerHTML=`<i class="ti ${TURN[t.k][2]}"></i>${t.k==='rb'&&t.exit>0?`<sup>${t.exit}</sup>`:''}${dist}`;
  el.title=cap(turnPhrase(t));
  el.dataset.kind=t.k;
}
window.navStart=function(){
  _nav={turns:buildTurns(),coords:routeCoords,off:false,offN:0,fin:false};
  syncVoiceBtn();
  // spoken inside the tap that starts the ride: a phone lets a page talk only after a touch
  if(_voice&&routeCoords.length) speak(say('Nawigacja głosowa włączona','Voice navigation on'));
};
window.navStop=function(){
  _nav=null;
  showTurn(null);
  try{if(canSpeak) speechSynthesis.cancel();}catch(_){}
};
// km: where on the route the rider is (null = far from it), offM: metres off it
window.navUpdate=function(km,offM,c){
  if(!_nav) return;
  if(_nav.coords!==routeCoords){_nav.turns=buildTurns();_nav.coords=routeCoords;_nav.fin=false;}
  if(km==null||offM>100){
    showTurn(null);
    if(!_nav.off&&++_nav.offN>=3){_nav.off=true;speak(say('Jesteś poza trasą','You are off the route'));}
    return;
  }
  _nav.offN=0;
  if(_nav.off){_nav.off=false;speak(say('Wracasz na trasę','Back on the route'));}
  const v=c&&c.speed>0.5?c.speed:(parseFloat($('avg-speed').value)||20)/3.6;   // m/s
  const far=clamp(v*30,100,400), near=clamp(v*6,25,60);
  const t=_nav.turns.find(x=>x.km>=km-0.015);
  for(const x of _nav.turns) if(x!==t&&(x.km-km)*1000>far+100) x.far=x.near=false; // ridden again later: announced again
  if(!t) showTurn(null);
  else{
    const m=(t.km-km)*1000;
    showTurn(t,m,m<=near);
    if(m<=near){if(!t.near){t.near=t.far=true;speak(cap(turnPhrase(t)));}}
    else if(m<=far){if(!t.far){t.far=true;speak(say('Za {n} metrów {co}','In {n} metres, {co}',{n:Math.round(m/50)*50||50,co:turnPhrase(t)}));}}
    else t.far=t.near=false;
  }
  if(!_nav.fin&&_planKm>0.5&&km>_planKm*0.5&&_planKm-km<0.15){_nav.fin=true;speak(say('Dojeżdżasz do mety','You are reaching the finish'));}
};

// ═══════════════════════════════════════════════════════════════════════
//  AFTER SIGNING IN
// ═══════════════════════════════════════════════════════════════════════
window.afterAuth=function(){
  syncInstall();
  if(_resetTok){showReset();return;}
  let tok=null;
  try{tok=sessionStorage.getItem(SHARED_KEY);sessionStorage.removeItem(SHARED_KEY);}catch(_){}
  if(tok) openShared(tok);
};
})();
