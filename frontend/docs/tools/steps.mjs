// Scenes for the docs screenshots. Start point: Warszawa Falenica station (public place, not the user's home).
const S = [52.16095, 21.21185];

export const helper = `
window.D=window.D||{
  sleep:ms=>new Promise(r=>setTimeout(r,ms)),
  async until(f,t=120000){const s=Date.now();while(!f()){if(Date.now()-s>t)throw new Error('timeout');await D.sleep(250);}},
  async ready(){
    await D.until(()=>typeof map!=='undefined'&&map&&typeof currentUser!=='undefined'&&currentUser,30000);
    await D.until(()=>(g('h-sq')?.textContent||'0')!=='0',60000).catch(()=>{});
    // keep the user's home out of the pictures: no home start, no "Dom" label
    currentUser.home_lat=null; currentUser.home_lng=null;
    window.labelWpt=async()=>{}; // no reverse-geocoded street names in the pictures
    window.saveLayerPrefs=()=>{}; applyLayerPrefs({'sqi-prio':false}); // pictures start from fixed layers and never touch the account's
    resetRoute();
    const st=document.createElement('style');st.id='doc-css';st.textContent='#toast{opacity:0!important}';document.head.appendChild(st);
    return g('h-sq').textContent;
  },
  toasts(on){g('doc-css').textContent=on?'':'#toast{opacity:0!important}';},
  layers(on){ // ensure exactly these square layers are on
    const all=['sq-own','sq-new','sq-yard','sq-uber','sqi-own','sqi-new','sqi-yard','sqi-uber','grid14','grid17','sqi-prio','sqi-noroad'];
    for(const n of all){const b=g('lb-'+n);if(!b)continue;const isOn=[...b.classList].some(c=>c.startsWith('on'));if(isOn!==on.includes(n))b.click();}
  },
  async route(o){
    resetRoute(); await D.sleep(200);
    document.querySelector('input[name=loop][value='+(o.ab?'ab':'loop')+']').click();
    document.querySelector('input[name=opt][value='+(o.opt||'sqi')+']').click();
    g('dist-r').value=o.km||40; g('dist-r').dispatchEvent(new Event('input'));
    const pid={standard:'bp-standard',fastbike:'bp-fastbike',gravel:'bp-gravel','rowery-pl':'bp-lowtraffic',safety:'bp-safety',mtb:'bp-mtb'}[o.prof||'safety'];
    setBikeProf(o.prof||'safety',g(pid));
    addWpt(L.latLng(o.start[0],o.start[1]),'start');
    if(o.end) addWpt(L.latLng(o.end[0],o.end[1]),'end');
    await calcRoute();
    await D.until(()=>routeCoords.length>1&&g('loading').classList.contains('h'),180000);
    await D.sleep(1500);
    return routeCoords.length;
  },
  async poi(){await D.until(()=>Object.values(poiItems||{}).some(l=>l.length),60000);},
  async photos(){await D.until(()=>photoLayer&&photoLayer.getLayers().length>5,120000);},
  quiet(on){ // route shots without POI / photo / Wikipedia pins
    if(!D._orig) D._orig={fetchPOI,fetchRoutePhotos,fetchWikiPOI};
    const noop=async()=>{};
    window.fetchPOI=on?noop:D._orig.fetchPOI; window.fetchRoutePhotos=on?noop:D._orig.fetchRoutePhotos; window.fetchWikiPOI=on?noop:D._orig.fetchWikiPOI;
    if(on){clearPOI();clearRoutePhotos();clearWikiPOI();}
  },
  async draw(pts,back){ // draw mode: real map clicks, wait until every leg is routed
    if(mode!=='draw') setMode('draw');
    for(const p of pts){const ll=L.latLng(p[0],p[1]);map.fire('click',{latlng:ll,containerPoint:map.latLngToContainerPoint(ll),originalEvent:{}});await D.sleep(650);}
    if(back) drawToStart();
    await D.until(()=>routeSegments.length===wpts.length-1&&!_drawBusy,120000);
    await D.sleep(800);
    return routeSegments.length;
  },
  view(lat,lng,z){map.setView([lat,lng],z,{animate:false});},
  fit(pb){map.invalidateSize();map.fitBounds(L.latLngBounds(routeCoords.map(p=>[p.lat,p.lng])),{paddingTopLeft:[30,70],paddingBottomRight:[30,pb||30],animate:false});},
};
`;

const DRAWPTS = '[[52.16095,21.21185],[52.1500,21.2250],[52.1400,21.2450],[52.1280,21.2350],[52.1330,21.2100]]';
const DRAWO = '[[52.1180,21.2500],[52.1060,21.2700],[52.0950,21.2550],[52.1030,21.2330]]';
const DRAW4 = '[[52.16095,21.21185],[52.1500,21.2250],[52.1400,21.2450],[52.1280,21.2350]]';
const route40 = `await D.route({start:[${S}],km:40,opt:'sqi',prof:'safety'});`;

export const steps = [
  // ── desktop ──
  { name: 'd-hero', device: 'desktop', wait: 3000, js: `D.quiet(true); D.layers(['sq-own','sqi-own','sq-uber','sqi-new','sq-new','grid14']); ${route40} D.fit(); return routeCoords.length;` },
  { name: 'd-form', device: 'desktop', wait: 1500, js: `if(!routeFormOpen)toggleRouteForm(); if(!g('adv-body').classList.contains('open'))toggleAdv(); g('tp-plan').scrollTop=0; return 1;` },
  { name: 'd-elev', device: 'desktop', wait: 2500, js: `if(routeFormOpen)toggleRouteForm(); toggleElev(); await D.sleep(800); D.fit(300); return 1;` },
  { name: 'd-poi', device: 'desktop', wait: 2500, js: `toggleElev(); D.quiet(false); fetchPOI(); fetchRoutePhotos(); fetchWikiPOI(); await D.poi(); g('poi-panel').scrollIntoView(); const it=(poiItems.food[2]||poiItems.food[0]||Object.values(poiItems).flat()[0]); map.setView([it.lat,it.lon],16,{animate:false}); map.panBy([0,-120],{animate:false}); it._marker.openPopup(); return it.tags?.name;` },
  { name: 'd-photos', device: 'desktop', wait: 3500, js: `await D.photos(); const ls=photoLayer.getLayers(); const m=ls.find(l=>{const c=l.getPopup().getContent();return /Commons/.test(typeof c==='function'?c():c)})||ls[0]; map.setView(m.getLatLng(),16,{animate:false}); map.panBy([0,-170],{animate:false}); m.openPopup(); return ls.length;` },
  { name: 'd-photos-mly', device: 'desktop', wait: 4000, js: `const ls=photoLayer.getLayers(); const m=ls.filter(l=>{const c=l.getPopup().getContent();return /Mapillary/.test(typeof c==='function'?c():c)})[3]||ls[1]; map.setView(m.getLatLng(),17,{animate:false}); map.panBy([0,-170],{animate:false}); m.openPopup(); return 1;` },
  { name: 'd-wiki', device: 'desktop', wait: 3000, js: `map.closePopup(); await D.until(()=>wikiLayer&&wikiLayer.getLayers().length,30000).catch(()=>{}); if(!wikiLayer) return 'no wiki'; const m=wikiLayer.getLayers()[0]; map.setView(m.getLatLng(),15,{animate:false}); map.panBy([0,-150],{animate:false}); m.openPopup(); return wikiLayer.getLayers().length;` },
  { name: 'd-sv', device: 'desktop', wait: 7000, js: `map.closePopup(); D.fit(); toggleSV(); await D.sleep(1500); const p=routeCoords[Math.floor(routeCoords.length*0.35)]; await openSV(p.lat,p.lng); return 1;` },
  { name: 'd-squares', device: 'desktop', reload: true, wait: 3500, js: `D.layers(['sq-own','sq-yard','sq-uber','grid14']); swTab('sq',document.querySelector('[onclick*="swTab(\\'sq\\'"]')); D.view(52.2,21.13,10); return 1;` },
  { name: 'd-sqi', device: 'desktop', wait: 3500, js: `D.layers(['sqi-own','sqi-yard','sqi-uber','grid17','sqi-noroad']); D.view(52.19,21.215,14); return 1;` },
  { name: 'd-prio', device: 'desktop', wait: 4000, js: `D.layers(['sqi-own','sqi-prio','sqi-uber']); await D.until(()=>prioData,60000); g('prio-panel').scrollIntoView(); D.view(52.19,21.22,13); return prioData.tiles.length;` },
  { name: 'd-prio-route', device: 'desktop', wait: 3500, js: `D.quiet(true); swTab('plan',document.querySelector('.tb')); D.toasts(true); await D.route({start:[${S}],km:40,opt:'prio',prof:'safety'}); D.fit(); return 1;` },
  { name: 'd-popular', device: 'desktop', wait: 4000, js: `D.toasts(false); D.layers([]); toggleGpsTraces(true,true); await D.route({start:[${S}],km:35,opt:'popular',prof:'safety'}); D.fit(); return 1;` },
  { name: 'd-ab', device: 'desktop', wait: 3500, js: `toggleGpsTraces(false,true); D.layers(['sqi-new','sq-new','sqi-own']); await D.route({start:[52.2319,21.0067],end:[${S}],ab:true,opt:'sqi',prof:'safety'}); D.fit(); return 1;` },
  { name: 'd-lidar', device: 'desktop', reload: true, wait: 6000, js: `D.layers(['grid17']); swTab('hm',document.querySelector('#tab-hm-btn')); togGeo('lidar',true,true); togGeo('bdl',true,true); D.view(52.1475,21.2410,15); return 1;` },
  { name: 'd-orto', device: 'desktop', wait: 14000, js: `togGeo('lidar',false,true); togGeo('bdl',false,true); togGeo('orto',true,true); togGeo('dzialki',true,true); D.layers(['sqi-own','grid17']); D.view(52.1866,21.2434,17); return 1;` },
  { name: 'd-gdos', device: 'desktop', wait: 5000, js: `togGeo('orto',false,true); togGeo('dzialki',false,true); togGeo('gdos',true,true); D.layers([]); D.view(52.13,21.25,12); return 1;` },
  { name: 'd-mapy', device: 'desktop', wait: 5000, js: `togGeo('gdos',false,true); chBase('mapyOutdoor'); D.layers(['sqi-own']); swTab('cfg',document.querySelector('[onclick*="swTab(\\'cfg\\'"]')); D.view(52.155,21.235,14); return 1;` },
  { name: 'd-routes', device: 'desktop', wait: 5000, js: `chBase('osm'); swTab('hm',document.querySelector('#tab-hm-btn')); showHM(); D.layers([]); D.view(52.22,21.1,11); return 1;` },
  { name: 'd-profile', device: 'desktop', reload: true, wait: 1500, js: `openProfile(); await D.sleep(1200); g('prof-email').textContent='rider@example.com'; g('prof-home-addr').value='Warszawa, stacja Falenica'; const c=g('prof-home-coords'); if(c) c.textContent='52.16095, 21.21185'; const sid=g('prof-strava-id'); if(sid) sid.value='123456'; return 1;` },
  { name: 'd-login', device: 'desktop', wait: 1500, js: `closeProfile(); g('auth-gate').style.display='flex'; return 1;` },

  { name: 'd-draw', device: 'desktop', reload: true, wait: 2500, js: `D.quiet(true); D.toasts(false); D.layers(['sqi-own','sqi-new','sq-new','grid17']); setBikeProf('safety',g('bp-safety')); D.view(52.145,21.228,14); await D.draw(${DRAWPTS}); setWptName(wpts[1],'Cafe'); map.invalidateSize(); map.fitBounds(L.latLngBounds(routeCoords.map(p=>[p.lat,p.lng])),{paddingTopLeft:[40,130],paddingBottomRight:[40,50],animate:false}); return _planKm.toFixed(1);` },
  { name: 'd-saved', device: 'desktop', reload: true, wait: 2500, js: `D.quiet(true); D.toasts(false); setBikeProf('safety',g('bp-safety'));
    const have=(await (await fetch('/api/routes')).json()).map(r=>r.name);
    const demo=[['Falenica → Józefów',${DRAW4},false],['Otwock wieczorem',${DRAWO},true],['Pętla przez Józefów',${DRAWPTS},true]];
    for(const [nm,pts,back] of demo){ if(have.includes(nm)) continue;
      clearRoute(); D.view(52.14,21.23,13); setMode('draw'); await D.draw(pts,back); setMode('view');
      await D.until(()=>g('loading').classList.contains('h')&&_routeMeta,60000); await D.sleep(500);
      openSaveRoute(); g('rc-save-name').value=nm; await saveRoute(); await D.sleep(300); }
    clearRoute(); setMode('view'); openRoutes(); await D.until(()=>g('rt-list').querySelectorAll('.rt-card').length>=3); await D.sleep(600); return g('rt-list').children.length;` },
  // ── phone ──
  { name: 'm-map', device: 'mobile', reload: true, wait: 3500, js: `g('auth-gate').style.display='none'; D.layers(['sq-own','sqi-own','sq-uber','grid14']); D.view(52.185,21.2,12); return 1;` },
  { name: 'm-sheet', device: 'mobile', wait: 2000, js: `openPlanSheet(); return 1;` },
  { name: 'm-route', device: 'mobile', wait: 3000, js: `D.quiet(true); closeMobileMenu(); D.layers(['sqi-own','sq-new','sqi-new','grid14']); ${route40} D.fit(110); return 1;` },
  { name: 'm-card', device: 'mobile', wait: 2000, js: `openPlanSheet(); return 1;` },
  { name: 'm-tools', device: 'mobile', wait: 2000, js: `closeMobileMenu(); D.fit(110); toggleMtoolsPop(); return 1;` },
  { name: 'm-poi', device: 'mobile', wait: 3000, js: `toggleMtoolsPop(); D.quiet(false); fetchPOI(); fetchRoutePhotos(); await D.poi(); const it=poiItems.sleep?.[0]||poiItems.food[0]; map.setView([it.lat,it.lon],16,{animate:false}); map.panBy([0,-140],{animate:false}); it._marker.openPopup(); return it.tags?.name;` },
  { name: 'm-photo', device: 'mobile', wait: 4000, js: `await D.photos(); const ls=photoLayer.getLayers(); const m=ls.filter(l=>{const c=l.getPopup().getContent();return /Mapillary/.test(typeof c==='function'?c():c)})[5]||ls[0]; map.setView(m.getLatLng(),16,{animate:false}); map.panBy([0,-190],{animate:false}); m.openPopup(); return 1;` },
  { name: 'm-elev', device: 'mobile', wait: 2500, js: `map.closePopup(); D.quiet(true); toggleElev(); await D.sleep(800); D.fit(330); return 1;` },
  { name: 'm-ride', device: 'mobile', wait: 3500, js: `if(g('elev-panel').style.display==='flex')toggleElev(); map.closePopup(); const p=routeCoords[Math.floor(routeCoords.length*0.3)]; navigator.geolocation.watchPosition=(ok)=>{setTimeout(()=>ok({coords:{latitude:p.lat,longitude:p.lng,accuracy:6,heading:null,speed:5},timestamp:Date.now()}),300);return 7;}; navigator.geolocation.clearWatch=()=>{}; toggleRide(); await D.sleep(2500); map.setZoom(16,{animate:false}); return g('ride-txt').textContent;` },
  { name: 'm-draw', device: 'mobile', reload: true, wait: 2500, js: `g('auth-gate').style.display='none'; D.quiet(true); D.toasts(false); D.layers(['sqi-own','sqi-new','sq-new']); setBikeProf('safety',g('bp-safety')); D.view(52.145,21.228,13); await D.draw(${DRAW4}); setWptName(wpts[1],'Cafe'); map.invalidateSize(); map.fitBounds(L.latLngBounds(routeCoords.map(p=>[p.lat,p.lng])),{paddingTopLeft:[30,170],paddingBottomRight:[30,120],animate:false}); return _planKm.toFixed(1);` },
  { name: 'm-saved', device: 'mobile', reload: true, wait: 2500, js: `g('auth-gate').style.display='none'; D.quiet(true); D.toasts(false); window.canShareGPX=()=>true; window.prefetchGPX=()=>{}; openRoutes(); await D.until(()=>g('rt-list').querySelector('.rt-card')); await D.sleep(600); return g('rt-list').children.length;` },
  { name: 'm-prio', device: 'mobile', reload: true, wait: 4000, js: `D.layers(['sqi-own','sqi-prio']); await D.until(()=>prioData,60000); D.view(52.19,21.22,13); return 1;` },
  { name: 'm-lidar', device: 'mobile', wait: 6000, js: `D.layers(['grid17']); togGeo('lidar',true,true); D.view(52.1475,21.2410,16); return 1;` },
  { name: 'm-squares', device: 'mobile', wait: 2500, js: `togGeo('lidar',false,true); D.layers(['sq-own','sq-yard','sq-uber']); D.view(52.215,21.13,10); openPlanSheet(); swTab('sq',document.querySelector('[onclick*="swTab(\\'sq\\'"]')); return 1;` },
];
