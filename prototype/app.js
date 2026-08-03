(function(){
  var nav=document.getElementById('nav');
  var state={name:'',circle:[],coords:null,notes:true,warn:true,warnMin:5};
  var AV=['#3b6ea5','#8a5cc4','#c47a3d','#3ca08a','#4d7ea8','#b6567f'];

  var TERMS="DRAFT — for review. Not legal advice.\n\n1. Not an emergency service\nMake It Home is NOT a substitute for calling 911. In a life-threatening situation, contact emergency services directly.\n\n2. No guarantee of delivery\nAlerts rely on your device, network, and carriers. Delivery isn't guaranteed and may fail or be delayed — don't rely on the app as your only way to get help.\n\n3. Your responsibilities\nOnly add contacts who agree to receive your emergency messages, and keep the required permissions enabled.\n\n4. Privacy\nYour use is governed by our Privacy Policy.\n\nContact: support@makeithome.app";
  var PRIVACY="DRAFT — for review. Not legal advice.\n\nWe only share your information when YOU trigger an alert or miss a check-in.\n\nWhat we collect\n• Precise location — to share with your circle during a session.\n• Contacts you add — stored to build your safety circle.\n• Audio/video — an emergency recording, only while recording.\n• Your name — shown in the alert.\n\nHow it's shared\nYour safety circle receives your name, a live-location link, and any recording, only when you trigger it. We never sell your data.\n\nSecurity & retention\nData travels over HTTPS, recordings are encrypted and auto-deleted within 24 hours, and you can delete all your data any time from Settings.\n\nContact: support@makeithome.app";

  function go(id){
    document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('on', v.id==='v-'+id);});
    nav.querySelectorAll('button').forEach(function(b){b.classList.toggle('on', b.dataset.go===id);});
    nav.classList.toggle('hide', ['home','circle','guide','settings'].indexOf(id)===-1);
    if(id==='escalation') renderEsc();
    if(id==='coverage') updateCoverage();
    if(id==='responder') updateResponder();
    if(id==='intro') updateIntro();
  }
  function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove('show');},2600); }

  // legal viewer
  var legalview=document.getElementById('legalview');
  function openLegal(which){ document.getElementById('legalTitle').textContent = which==='privacy'?'Privacy Policy':'Terms of Service';
    document.getElementById('legalBody').textContent = which==='privacy'?PRIVACY:TERMS; legalview.classList.add('show'); }
  document.getElementById('legalClose').addEventListener('click',function(){legalview.classList.remove('show');});
  document.querySelectorAll('[data-legal]').forEach(function(el){el.addEventListener('click',function(){openLegal(el.dataset.legal);});});

  // step 1 name
  var nameInput=document.getElementById('nameInput'), nameCont=document.getElementById('nameContinue');
  nameInput.addEventListener('input',function(){ state.name=nameInput.value.trim(); nameCont.classList.toggle('dim', !state.name); });
  nameCont.addEventListener('click',function(){ if(!state.name){nameInput.focus();return;} go('terms'); });
  // step 2 terms
  document.getElementById('agreeBtn').addEventListener('click',function(){ go('location'); });
  // step 3 location
  function finishLoc(ok,msg){ updateMap(); var s=document.getElementById('locStatus');
    if(ok){ s.textContent='Location on · '+state.coords.lat.toFixed(4)+', '+state.coords.lng.toFixed(4); s.className='locstat ok'; }
    else { s.textContent=(msg||'Location unavailable')+' — you can still explore the prototype'; s.className='locstat'; }
    sync(); setTimeout(function(){ go('home'); }, ok?800:1300); }
  document.getElementById('allowLoc').addEventListener('click',function(){
    this.textContent='Locating…';
    if(!navigator.geolocation){ finishLoc(false,'Location not supported'); return; }
    navigator.geolocation.getCurrentPosition(
      function(pos){ state.coords={lat:pos.coords.latitude,lng:pos.coords.longitude}; finishLoc(true); },
      function(err){ finishLoc(false, err && err.code===1 ? 'Permission blocked in preview' : 'Couldn’t get location'); },
      {enableHighAccuracy:false,timeout:8000,maximumAge:60000});
  });
  document.getElementById('locSkip').addEventListener('click',function(){ finishLoc(false,'Location skipped'); });
  function updateMap(){ var tag=document.getElementById('mapTag');
    if(state.coords){ tag.innerHTML='<b>●</b> Live location on · '+state.coords.lat.toFixed(4)+', '+state.coords.lng.toFixed(4); }
    else { tag.innerHTML='<b style="color:#ff8a6e">●</b> Location off'; } }

  // circle + prefs
  function sync(){
    document.getElementById('setName').textContent=state.name||'—';
    var setLoc=document.getElementById('setLoc'); setLoc.textContent=state.coords?'On':'Off'; setLoc.className='val'+(state.coords?' on':'');
    document.getElementById('notesTgl').classList.toggle('on', state.notes);
    document.getElementById('warnTgl').classList.toggle('on', state.warn);
    var wm=document.getElementById('warnMinVal'); wm.textContent=state.warnMin+' min'; wm.className='val'+(state.warn?'':' dim');
    var list=document.getElementById('circleList'); list.innerHTML='';
    state.circle.forEach(function(c,i){
      var initials=c.name.split(/\s+/).map(function(w){return w[0];}).join('').slice(0,2).toUpperCase()||'?';
      var row=document.createElement('div'); row.className='row'; row.style.cursor='pointer';
      row.innerHTML='<div class="av" style="background:'+AV[i%AV.length]+'">'+initials+'</div><div style="flex:1"><div class="nm"></div><div class="ph"></div></div><span style="color:var(--faint)">›</span>';
      row.querySelector('.nm').textContent=c.name; row.querySelector('.ph').textContent=c.phone;
      row.addEventListener('click',function(){openContact(i);});
      list.appendChild(row);
    });
    document.getElementById('circleEmpty').style.display=state.circle.length?'none':'flex';
    var n=state.circle.length;
    document.getElementById('coverName').textContent = n? "You're covered" : "Almost ready";
    document.getElementById('coverSub').textContent = n? (n+' '+(n===1?'person has':'people have')+' your back') : 'Add someone — no one is alerted yet';
    var cp=document.getElementById('coverPip'); if(cp){ cp.style.background=n?'var(--safe)':'#ffb020'; cp.style.boxShadow='0 0 0 4px '+(n?'rgba(75,214,166,.15)':'rgba(255,176,32,.15)'); }
  }
  document.getElementById('notesToggle').addEventListener('click',function(){ state.notes=!state.notes; sync(); });
  document.getElementById('warnToggle').addEventListener('click',function(){ state.warn=!state.warn; sync(); });
  document.getElementById('warnMinRow').addEventListener('click',function(){ if(!state.warn)return; state.warnMin=state.warnMin===5?10:5; sync(); });

  var sheet=document.getElementById('sheet'); var editIdx=-1;
  document.getElementById('addContact').addEventListener('click',function(){ editIdx=-1; document.getElementById('addTitle').textContent='Add someone'; document.getElementById('cSave').textContent='Add'; document.getElementById('cName').value='';document.getElementById('cPhone').value='';sheet.classList.add('show');});
  document.getElementById('cCancel').addEventListener('click',function(){sheet.classList.remove('show');});
  document.getElementById('cSave').addEventListener('click',function(){
    var n=document.getElementById('cName').value.trim(), p=document.getElementById('cPhone').value.trim();
    if(!n||!p) return;
    if(editIdx>=0){ state.circle[editIdx]={name:n,phone:p}; editIdx=-1; } else { state.circle.push({name:n,phone:p}); }
    sheet.classList.remove('show'); sync(); });

  // contact action sheet: fake call / edit / remove
  var csheet=document.getElementById('csheet'); var csIdx=-1;
  function openContact(i){ csIdx=i; var c=state.circle[i]; document.getElementById('csName').textContent=c.name; document.getElementById('csPhone').textContent=c.phone; csheet.classList.add('show'); }
  document.getElementById('csCancel').addEventListener('click',function(){csheet.classList.remove('show');});
  document.getElementById('csFakeCall').addEventListener('click',function(){ var c=state.circle[csIdx]; csheet.classList.remove('show'); fakeCallFrom(c?c.name:'Mom'); });
  document.getElementById('csRemove').addEventListener('click',function(){ if(csIdx>=0) state.circle.splice(csIdx,1); csheet.classList.remove('show'); sync(); });
  document.getElementById('csEdit').addEventListener('click',function(){ var c=state.circle[csIdx]; editIdx=csIdx; document.getElementById('addTitle').textContent='Edit contact'; document.getElementById('cSave').textContent='Save'; document.getElementById('cName').value=c.name; document.getElementById('cPhone').value=c.phone; csheet.classList.remove('show'); sheet.classList.add('show'); });
  function fakeCallFrom(name){ name=name||'Mom'; document.getElementById('callNm').textContent=name; document.getElementById('callAv').textContent=(name[0]||'?').toUpperCase(); go('fakecall'); }

  // escalation ladder: drag to reorder + editable wait
  var waitCycle=[2,3,5,10], waitMins=3, escDrag=null;
  function renderEsc(){
    var list=document.getElementById('escList'); if(!list) return; list.innerHTML='';
    if(state.circle.length===0){
      list.innerHTML='<div style="padding:18px 6px;text-align:center;color:var(--muted);font-size:13px">No one in your circle yet. <span id="escAdd" style="color:var(--beacon);font-weight:700;cursor:pointer">Add someone</span> to build your ladder.</div>';
      var a=document.getElementById('escAdd'); if(a) a.addEventListener('click',function(){go('circle');});
      return;
    }
    state.circle.forEach(function(c,i){
      var when=i===0?'Alerted first':'+'+(i*waitMins)+' min';
      var row=document.createElement('div'); row.className='srow escrow'; row.dataset.idx=i;
      row.innerHTML='<span style="display:flex;align-items:center;gap:10px;flex:1"><span class="rank'+(i===0?' first':'')+'">'+(i+1)+'</span><span><b style="font-weight:600"></b> <span style="color:var(--faint);font-size:11px">· '+when+'</span></span></span><span class="handle">⋮⋮</span>';
      row.querySelector('b').textContent=c.name;
      list.appendChild(row);
    });
    [].slice.call(list.querySelectorAll('.escrow')).forEach(function(row){
      row.addEventListener('pointerdown',function(e){ e.preventDefault(); escDrag={idx:+row.dataset.idx,startY:e.clientY,row:row,h:row.offsetHeight||48}; row.style.transition='none'; row.style.position='relative'; row.style.zIndex=5; row.style.background='var(--surface2)'; row.style.borderRadius='10px'; try{row.setPointerCapture(e.pointerId);}catch(_){}});
      row.addEventListener('pointermove',function(e){ if(escDrag&&escDrag.row===row) row.style.transform='translateY('+(e.clientY-escDrag.startY)+'px)'; });
      function end(e){ if(!escDrag||escDrag.row!==row) return; var dy=(e.clientY||escDrag.startY)-escDrag.startY, from=escDrag.idx, to=Math.max(0,Math.min(state.circle.length-1, from+Math.round(dy/escDrag.h))); escDrag=null; if(to!==from){ var it=state.circle.splice(from,1)[0]; state.circle.splice(to,0,it); } renderEsc(); sync(); }
      row.addEventListener('pointerup',end); row.addEventListener('pointercancel',end);
    });
  }
  document.getElementById('waitRow').addEventListener('click',function(){ waitMins=waitCycle[(waitCycle.indexOf(waitMins)+1)%waitCycle.length]; document.getElementById('waitVal').textContent=waitMins+' min ›'; renderEsc(); });

  function updateCoverage(){
    var n=state.circle.length, covered=n>0;
    var cc=document.getElementById('covContacts'); if(cc){ cc.textContent=(n?(n+' ›'):'None yet ›'); cc.className='val'+(covered?' on':' warnc'); }
    var t=document.getElementById('covTitle'), s=document.getElementById('covSub'), p=document.getElementById('covPip');
    if(t) t.textContent=covered?"You're covered":"Not covered yet";
    if(s) s.textContent=covered?"Your circle will be alerted if you signal.":"No one is in your circle — an alert would reach nobody.";
    if(p){ p.style.background=covered?'var(--safe)':'#ffb020'; p.style.boxShadow='0 0 0 4px '+(covered?'rgba(75,214,166,.15)':'rgba(255,176,32,.15)'); }
  }
  function updateResponder(){ var nm=state.name||'Your contact'; var a=document.getElementById('respName'), b=document.getElementById('respName2'); if(a)a.textContent=nm; if(b)b.textContent=nm; }
  function updateIntro(){ var nm=state.name||'Your contact'; ['introName','introName2','introName3','introName4'].forEach(function(id){var el=document.getElementById(id); if(el)el.textContent=nm;}); var av=document.getElementById('introAv'); if(av)av.textContent=(nm[0]||'?').toUpperCase(); }

  document.getElementById('deleteBtn').addEventListener('click',function(){ state={name:'',circle:[],coords:null,notes:true,warn:true,warnMin:5};
    nameInput.value=''; nameCont.classList.add('dim'); document.getElementById('locStatus').textContent='Location is off'; document.getElementById('locStatus').className='locstat';
    document.getElementById('allowLoc').textContent='Allow location'; updateMap(); sync(); go('name'); });

  document.getElementById('supportBtn').addEventListener('click',function(){ toast('Support · support@makeithome.app'); });
  document.getElementById('supportBtn2').addEventListener('click',function(){ toast('Support · support@makeithome.app'); });

  nav.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){go(b.dataset.go);});});
  document.querySelectorAll('[data-go]').forEach(function(el){ if(!el.closest('#nav')) el.addEventListener('click',function(){go(el.dataset.go); if(el.dataset.toast) toast(el.dataset.toast);}); });
  document.querySelectorAll('[data-toggle]').forEach(function(t){ t.addEventListener('click',function(e){ e.stopPropagation(); t.classList.toggle('on'); }); });

  // beacon gesture
  var beacon=document.getElementById('beacon'), arena=document.getElementById('arena'),
      live=document.getElementById('live'), livet=document.getElementById('livet'),
      lives=document.getElementById('lives'), livetimer=document.getElementById('livetimer'),
      end=document.getElementById('end'), bsub=document.getElementById('bsub'), msgsheet=document.getElementById('msgsheet'), msgTA=document.getElementById('msgText');
  var opts={}; arena.querySelectorAll('.opt').forEach(function(o){opts[o.dataset.k]=o;});
  var pressing=false, sel='now', pendingSel='now'; var MIN={left:'15:00',up:'30:00',right:'45:00',down:'60:00'}, LBL={left:'15',up:'30',right:'45',down:'60'};
  var msgTimer=null, msgAuto=true;
  function choose(k){ if(k===sel)return; sel=k; for(var key in opts) opts[key].classList.toggle('sel',key===k); }
  function pick(x,y){ var r=beacon.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,dx=x-cx,dy=y-cy;
    if(Math.hypot(dx,dy)<42){choose('now');return;} if(Math.abs(dx)>Math.abs(dy))choose(dx<0?'left':'right');else choose(dy<0?'up':'down'); }
  beacon.addEventListener('pointerdown',function(e){e.preventDefault();pressing=true;sel='';choose('now');arena.classList.add('armed');beacon.classList.remove('idle');bsub.textContent='release';try{beacon.setPointerCapture(e.pointerId);}catch(_){}});
  beacon.addEventListener('pointermove',function(e){if(pressing)pick(e.clientX,e.clientY);});

  function showLive(k,note){ livet.textContent=k==='now'?'You’re live':'Check-in started';
    var base = k==='now' ? 'Sharing your live location and recording with your circle.' : 'If you don’t check in, your circle is alerted with your location.';
    if(k!=='now' && state.warn){ base += ' We’ll remind you '+state.warnMin+' min before.'; }
    if(note){ base += ' Note: “'+note+'”'; }
    lives.textContent = base;
    if(k==='now'){livetimer.style.display='none';}else{livetimer.style.display='block';livetimer.textContent=MIN[k];}
    live.classList.add('show'); }

  function openMsg(k){
    if(!state.notes){ showLive(k,''); return; }                 // notes disabled → straight to check-in
    pendingSel=k;
    document.getElementById('msgTitle').textContent='Check-in · '+LBL[k]+' min';
    document.getElementById('msgHint').innerHTML='Starting in <b id="msgCount">4</b>s — type a note, or just wait.';
    msgTA.value=''; var cd=4; msgAuto=true; msgsheet.classList.add('show');
    clearInterval(msgTimer);
    msgTimer=setInterval(function(){ if(!msgAuto)return; cd--; if(cd<=0){ startMsg(''); } else { var el=document.getElementById('msgCount'); if(el)el.textContent=cd; } },1000);
  }
  function cancelAuto(){ if(msgAuto){ msgAuto=false; clearInterval(msgTimer); document.getElementById('msgHint').textContent='Take your time — tap Start when you’re ready.'; } }
  function startMsg(note){ clearInterval(msgTimer); msgAuto=false; msgsheet.classList.remove('show'); showLive(pendingSel,note); }
  msgTA.addEventListener('focus',cancelAuto); msgTA.addEventListener('input',cancelAuto); msgTA.addEventListener('pointerdown',cancelAuto);
  document.getElementById('msgStart').addEventListener('click',function(){ startMsg(msgTA.value.trim()); });

  function release(){ if(!pressing)return;pressing=false;arena.classList.remove('armed');beacon.classList.add('idle');bsub.innerHTML='&amp; swipe';
    for(var k in opts)opts[k].classList.remove('sel');
    if(state.circle.length===0){ toast('⚠ No one will be alerted — add someone to your circle first'); go('circle'); return; }
    if(sel==='now'){ showLive('now',''); } else { openMsg(sel); } }
  beacon.addEventListener('pointerup',release); beacon.addEventListener('pointercancel',release);
  // PIN to end an active alert (mirror of the duress feature)
  var pinpad=document.getElementById('pinpad'), pinEntered='', PIN='1234';
  function updatePinDots(){ var d=document.getElementById('pinDots').children; for(var i=0;i<4;i++) d[i].classList.toggle('on', i<pinEntered.length); }
  function openPin(){ pinEntered=''; updatePinDots(); document.getElementById('pinErr').textContent=''; pinpad.classList.add('show'); }
  function pinSuccess(){ pinpad.classList.remove('show'); live.classList.remove('show'); toast("✓ Circle notified — false alarm, you're safe"); }
  document.getElementById('keys').addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b) return; var k=b.dataset.k;
    if(k==='del'){ pinEntered=pinEntered.slice(0,-1); updatePinDots(); return; }
    if(k==='face'){ document.getElementById('pinErr').textContent='Confirming with Face ID…'; setTimeout(pinSuccess,650); return; }
    if(pinEntered.length>=4) return;
    pinEntered+=b.textContent.trim(); updatePinDots();
    if(pinEntered.length===4){ setTimeout(function(){
      if(pinEntered===PIN){ pinSuccess(); }
      else { document.getElementById('pinErr').textContent='Incorrect PIN — try again'; pinpad.classList.add('shake'); setTimeout(function(){ pinpad.classList.remove('shake'); pinEntered=''; updatePinDots(); },440); }
    },130); }
  });
  document.getElementById('pinCancel').addEventListener('click',function(){ pinpad.classList.remove('show'); });
  end.addEventListener('click',function(){ openPin(); });

  // prototype navigator — jump to any screen / state
  document.querySelectorAll('.navpanel a').forEach(function(a){
    a.addEventListener('click',function(){
      document.querySelectorAll('.navpanel a').forEach(function(x){x.classList.toggle('active',x===a);});
      var id=a.dataset.s;
      if(id==='live'){ go('home'); showLive('now',''); return; }
      if(id==='pin'){ go('home'); showLive('now',''); openPin(); return; }
      go(id);
    });
  });

  updateMap(); sync();
})();
