/**
 * Build a self-contained HTML game document from raw game logic JS.
 * Includes: Three.js r128 helpers, escape menu, chat, WebSocket multiplayer,
 * mobile controls, procedural sound engine.
 */

export function extractGameLogic(gameCode: string): string {
  const markerMatch = gameCode.match(/\/\/ === GAME_LOGIC_START ===\n([\s\S]*?)\n\/\/ === GAME_LOGIC_END ===/);
  if (markerMatch) return markerMatch[1].trim();
  if (!gameCode.includes('<!DOCTYPE') && !gameCode.includes('<html')) return gameCode.trim();
  const scriptMatch = gameCode.match(/<script[^>]*>([\s\S]*?)<\/script>\s*<\/body>/i);
  if (scriptMatch) return scriptMatch[1].trim();
  return gameCode.trim();
}

export function buildGameHtml(gameLogic: string, uiColor = '#44ee88'): string {

  const setupSceneFn = `
function setupScene(opts){
  opts=opts||{};
  var renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth,window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=opts.exposure!=null?opts.exposure:1.1;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction='none'; renderer.domElement.style.overscrollBehavior='none';
  var scene=new THREE.Scene();
  scene.background=new THREE.Color(opts.skyColor||'#1a1a3e');
  scene.fog=new THREE.FogExp2(opts.fogColor||'#1a1a3e',opts.fogDensity!=null?opts.fogDensity:0.032);
  var hemi=new THREE.HemisphereLight(opts.skyLightColor||'#8899cc',opts.groundLightColor||'#553322',opts.hemiIntensity!=null?opts.hemiIntensity:0.55);
  scene.add(hemi);
  var sun=new THREE.DirectionalLight(opts.sunColor||'#fff5e0',opts.sunIntensity!=null?opts.sunIntensity:1.8);
  sun.position.set(opts.sunX!=null?opts.sunX:40,opts.sunY!=null?opts.sunY:60,opts.sunZ!=null?opts.sunZ:30);
  sun.castShadow=true; sun.shadow.mapSize.width=2048; sun.shadow.mapSize.height=2048;
  var sc=opts.shadowCoverage!=null?opts.shadowCoverage:70;
  sun.shadow.camera.left=-sc; sun.shadow.camera.right=sc; sun.shadow.camera.top=sc; sun.shadow.camera.bottom=-sc;
  sun.shadow.camera.near=0.5; sun.shadow.camera.far=400; sun.shadow.bias=-0.0008;
  scene.add(sun);
  window.addEventListener('resize',function(){ renderer.setSize(window.innerWidth,window.innerHeight); });
  return {scene:scene,renderer:renderer,sun:sun,hemi:hemi};
}`;

  const setupCameraFn = `
function setupCamera(opts){
  opts=opts||{};
  var dist=opts.distance!=null?opts.distance:6, minDist=opts.minDistance!=null?opts.minDistance:2, maxDist=opts.maxDistance!=null?opts.maxDistance:22;
  var sens=opts.sensitivity!=null?opts.sensitivity:0.003;
  var yaw=opts.yaw!=null?opts.yaw:0, pitch=opts.pitch!=null?opts.pitch:0.42;
  var minPitch=opts.minPitch!=null?opts.minPitch:-0.05, maxPitch=opts.maxPitch!=null?opts.maxPitch:1.05;
  var w=window.innerWidth>0?window.innerWidth:800, h=window.innerHeight>0?window.innerHeight:600;
  var cam=new THREE.PerspectiveCamera(65,w/h,0.1,2000);
  window.addEventListener('resize',function(){ var nw=window.innerWidth||800,nh=window.innerHeight||600; cam.aspect=nw/nh; cam.updateProjectionMatrix(); });
  var _rmbHeld=false, _lastX=0, _lastY=0, _shiftLocked=false;
  var _mouseX=window.innerWidth/2, _mouseY=window.innerHeight/2;
  document.addEventListener('pointermove',function(e){ if(e.pointerType==='mouse'){_mouseX=e.clientX;_mouseY=e.clientY;} },{capture:true,passive:true});
  var _slEl=document.createElement('div');
  _slEl.style.cssText='position:fixed;bottom:14px;right:14px;padding:4px 10px;background:rgba(0,0,0,0.6);color:#fff;font:bold 11px/1.5 monospace;border-radius:6px;pointer-events:none;opacity:0;transition:opacity 0.18s;z-index:9998;';
  _slEl.textContent='SHIFT LOCK  ON'; document.body.appendChild(_slEl);
  var _xhair=document.createElement('div'); _xhair.id='_sl_crosshair';
  _xhair.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:22px;height:22px;pointer-events:none;display:none;z-index:9999;';
  _xhair.innerHTML='<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><line x1="11" y1="2" x2="11" y2="20" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/><line x1="2" y1="11" x2="20" y2="11" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/><circle cx="11" cy="11" r="2.5" fill="none" stroke="white" stroke-width="1.2" opacity="0.85"/></svg>';
  document.body.appendChild(_xhair);
  function _setShiftLock(on){
    _shiftLocked=on; _slEl.style.opacity=on?'1':'0'; _xhair.style.display=on?'block':'none'; document.body.style.cursor=on?'none':'';
    if(on){ _lastX=_mouseX; _lastY=_mouseY; var el=document.body; if(el&&el.requestPointerLock){ try{ var p=el.requestPointerLock({unadjustedMovement:true}); if(p&&typeof p.catch==='function') p.catch(function(){ try{el.requestPointerLock();}catch(_){} }); }catch(_){ try{el.requestPointerLock();}catch(__){} } } }
    else{ if(document.pointerLockElement&&document.exitPointerLock) document.exitPointerLock(); }
    var btn=document.getElementById('esc-shiftlock-btn'); if(btn) btn.textContent='Shift Lock: '+(on?'ON':'OFF');
  }
  document.addEventListener('pointerlockchange',function(){ if(!document.pointerLockElement&&_shiftLocked){ _shiftLocked=false; _slEl.style.opacity='0'; _xhair.style.display='none'; document.body.style.cursor=''; var btn=document.getElementById('esc-shiftlock-btn'); if(btn){btn.textContent='Shift Lock: OFF';btn.classList.remove('active');} } });
  document.addEventListener('keydown',function(e){ if(e.key==='Tab'&&document.activeElement&&document.activeElement.tagName!=='INPUT'){ e.preventDefault(); _setShiftLock(!_shiftLocked); } });
  document.addEventListener('contextmenu',function(e){ e.preventDefault(); });
  document.addEventListener('mousedown',function(e){ if(e.button===2){ _rmbHeld=true; _lastX=e.clientX; _lastY=e.clientY; } });
  document.addEventListener('mouseup',function(e){ if(e.button===2) _rmbHeld=false; });
  document.addEventListener('mousemove',function(e){
    var dx,dy;
    if(document.pointerLockElement){ dx=e.movementX||0; dy=e.movementY||0; }
    else if(_rmbHeld||_shiftLocked){ dx=e.clientX-_lastX; dy=e.clientY-_lastY; _lastX=e.clientX; _lastY=e.clientY; }
    else return;
    if(_shiftLocked||_rmbHeld){ yaw-=dx*sens; pitch=Math.max(minPitch,Math.min(maxPitch,pitch-dy*sens)); }
  });
  document.addEventListener('wheel',function(e){ dist=Math.max(minDist,Math.min(maxDist,dist+e.deltaY*0.005)); },{passive:true});
  function update(target){
    var tx=target.x||0, ty=(target.y||0)+1.6, tz=target.z||0;
    var x=tx+dist*Math.sin(yaw)*Math.cos(pitch);
    var y=ty+dist*Math.sin(pitch);
    var z=tz+dist*Math.cos(yaw)*Math.cos(pitch);
    cam.position.set(x,y,z); cam.lookAt(tx,ty,tz);
  }
  function forward(){ return new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)).normalize(); }
  function right(){ return new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw)).normalize(); }
  window._camera={ camera:cam, update:update, forward:forward, right:right,
    getSensitivity:function(){return sens;}, setSensitivity:function(v){sens=v;},
    isShiftLocked:function(){return _shiftLocked;}, setShiftLock:_setShiftLock,
    resetDeltaOrigin:function(){_lastX=_mouseX;_lastY=_mouseY;},
    touchOrbit:function(dx,dy,s){ yaw-=dx*(s||sens); pitch=Math.max(minPitch,Math.min(maxPitch,pitch-dy*(s||sens))); }
  };
  return window._camera;
}`;

  const setupPhysicsFn = `
function setupPhysics(opts){
  opts=opts||{};
  var maxSpeed=opts.maxSpeed!=null?opts.maxSpeed:7.5;
  var accel=opts.acceleration!=null?opts.acceleration:80;
  var jumpVel=opts.jumpVelocity!=null?opts.jumpVelocity:10.5;
  var gravity=opts.gravity!=null?opts.gravity:-28;
  var vx=0,vy=0,vz=0, ix=0,iz=0, grounded=false;
  function setInput(x,z){ ix=x; iz=z; }
  function update(pos,dt){
    if(dt>0.1) dt=0.1;
    // Horizontal
    var tx=ix*maxSpeed, tz=iz*maxSpeed;
    vx+=(tx-vx)*Math.min(1,accel*dt); vz+=(tz-vz)*Math.min(1,accel*dt);
    // Gravity
    vy+=gravity*dt;
    // Move
    pos.x+=vx*dt; pos.y+=vy*dt; pos.z+=vz*dt;
    // Floor
    var floor=opts.getFloor?opts.getFloor(pos.x,pos.z):0;
    if(pos.y<=floor){ pos.y=floor; if(vy<0) vy=0; grounded=true; } else { grounded=false; }
    // Collidables (simple AABB push-out)
    var cols=window._collidables||[];
    for(var i=0;i<cols.length;i++){
      var b=cols[i];
      if(!b.geometry) continue;
      b.geometry.computeBoundingBox();
      var bb=new THREE.Box3().setFromObject(b);
      var pt=new THREE.Vector3(pos.x,pos.y+0.9,pos.z);
      if(bb.containsPoint(pt)){
        var center=new THREE.Vector3(); bb.getCenter(center);
        var dx=pos.x-center.x, dz=pos.z-center.z;
        var len=Math.sqrt(dx*dx+dz*dz)||1;
        pos.x+=dx/len*0.15; pos.z+=dz/len*0.15;
        vx=0; vz=0;
      }
    }
    return grounded;
  }
  var _jumpQueued=false;
  document.addEventListener('keydown',function(e){ if((e.key===' '||e.code==='Space')&&grounded&&!window._gamePaused&&(!document.activeElement||document.activeElement.tagName!=='INPUT')){ vy=jumpVel; _jumpQueued=true; } });
  function reset(){ vx=0;vy=0;vz=0; }
  window._physics={ setInput:setInput, update:update, isGrounded:function(){return grounded;}, velocityX:function(){return vx;}, velocityY:function(){return vy;}, velocityZ:function(){return vz;}, reset:reset };
  return window._physics;
}`;

  const buildAvatarFn = `
function buildAvatar(scene,x,y,z){
  var cfg=window.AVATAR_CONFIG||{};
  var bodyColor=cfg.bodyColor||'#f9c8a0';
  var g=new THREE.Group(); g.position.set(x,y,z);
  // Body
  var body=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.9,0.35),new THREE.MeshStandardMaterial({color:bodyColor}));
  body.castShadow=true; body.position.y=0.9; g.add(body);
  // Head
  var head=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.55,0.55),new THREE.MeshStandardMaterial({color:bodyColor}));
  head.castShadow=true; head.position.y=1.7; g.add(head);
  // Left arm
  var la=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.7,0.22),new THREE.MeshStandardMaterial({color:bodyColor}));
  la.castShadow=true; la.position.set(-0.46,0.9,0); g.add(la);
  // Right arm
  var ra=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.7,0.22),new THREE.MeshStandardMaterial({color:bodyColor}));
  ra.castShadow=true; ra.position.set(0.46,0.9,0); g.add(ra);
  // Left leg
  var ll=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.8,0.28),new THREE.MeshStandardMaterial({color:'#2c2c2c'}));
  ll.castShadow=true; ll.position.set(-0.2,0.4,0); g.add(ll);
  // Right leg
  var rl=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.8,0.28),new THREE.MeshStandardMaterial({color:'#2c2c2c'}));
  rl.castShadow=true; rl.position.set(0.2,0.4,0); g.add(rl);
  // Walk animation state
  var _walkT=0;
  g.update=function(dt){
    var phys=window._physics; var spd=phys?Math.sqrt(phys.velocityX()*phys.velocityX()+phys.velocityZ()*phys.velocityZ()):0;
    if(spd>0.5&&!window._gamePaused){ _walkT+=dt*spd*2.2; la.rotation.x=Math.sin(_walkT)*0.5; ra.rotation.x=-Math.sin(_walkT)*0.5; ll.rotation.x=-Math.sin(_walkT)*0.5; rl.rotation.x=Math.sin(_walkT)*0.5; }
    else{ la.rotation.x*=0.8; ra.rotation.x*=0.8; ll.rotation.x*=0.8; rl.rotation.x*=0.8; }
  };
  g.setJumping=function(on){ la.rotation.x=on?-0.5:0; ra.rotation.x=on?-0.5:0; };
  scene.add(g);
  return g;
}`;

  const soundEngineFn = `
(function(){
  var _ac=null;
  try{_ac=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}
  window._audioCtx=_ac;
  function _resume(){if(_ac&&_ac.state==='suspended')_ac.resume().catch(function(){});}
  document.addEventListener('keydown',_resume,{passive:true});
  document.addEventListener('pointerdown',_resume,{passive:true});
  document.addEventListener('touchstart',_resume,{passive:true});
  function _safe(fn){try{fn();}catch(e){}}
  function _sfxJump(){if(!_ac)return;_safe(function(){var t=_ac.currentTime;var osc=_ac.createOscillator();var gain=_ac.createGain();osc.type='sine';osc.frequency.setValueAtTime(180,t);osc.frequency.exponentialRampToValueAtTime(520,t+0.13);gain.gain.setValueAtTime(0.22,t);gain.gain.linearRampToValueAtTime(0,t+0.20);osc.connect(gain);gain.connect(_ac.destination);osc.start(t);osc.stop(t+0.20);});}
  function _sfxLand(v){if(!_ac)return;_safe(function(){var t=_ac.currentTime;var intensity=Math.max(0.25,Math.min(1.0,Math.abs(v||5)/12));var frames=Math.floor(_ac.sampleRate*0.10);var buf=_ac.createBuffer(1,frames,_ac.sampleRate);var d=buf.getChannelData(0);for(var i=0;i<frames;i++)d[i]=Math.random()*2-1;var noise=_ac.createBufferSource();noise.buffer=buf;var filt=_ac.createBiquadFilter();filt.type='lowpass';filt.frequency.value=200+intensity*100;var ng=_ac.createGain();ng.gain.setValueAtTime(0.45*intensity,t);ng.gain.exponentialRampToValueAtTime(0.001,t+0.10);noise.connect(filt);filt.connect(ng);ng.connect(_ac.destination);noise.start(t);var sub=_ac.createOscillator();var sg=_ac.createGain();sub.type='sine';sub.frequency.setValueAtTime(95+intensity*25,t);sub.frequency.exponentialRampToValueAtTime(28,t+0.09);sg.gain.setValueAtTime(0.55*intensity,t);sg.gain.exponentialRampToValueAtTime(0.001,t+0.10);sub.connect(sg);sg.connect(_ac.destination);sub.start(t);sub.stop(t+0.11);});}
  function _sfxFootstep(){if(!_ac)return;_safe(function(){var t=_ac.currentTime;var frames=Math.floor(_ac.sampleRate*0.045);var buf=_ac.createBuffer(1,frames,_ac.sampleRate);var d=buf.getChannelData(0);for(var i=0;i<frames;i++)d[i]=Math.random()*2-1;var noise=_ac.createBufferSource();noise.buffer=buf;var filt=_ac.createBiquadFilter();filt.type='bandpass';filt.frequency.value=270;filt.Q.value=1.0;var gain=_ac.createGain();gain.gain.setValueAtTime(0.11,t);gain.gain.exponentialRampToValueAtTime(0.001,t+0.05);noise.connect(filt);filt.connect(gain);gain.connect(_ac.destination);noise.start(t);});}
  window._sfx={jump:_sfxJump,land:_sfxLand,footstep:_sfxFootstep,getContext:function(){return _ac;}};
  document.addEventListener('keydown',function(e){if(e.code!=='Space'&&e.key!==' ')return;if(window._gamePaused)return;if(document.activeElement&&document.activeElement.tagName==='INPUT')return;var phys=window._physics;if(phys&&phys.isGrounded&&phys.isGrounded())_sfxJump();},{passive:true});
  var _prevGrounded=true,_prevVY=0,_prevY=0,_walkTimer=0,_loopPrev=performance.now();
  (function _sfxLoop(now){requestAnimationFrame(_sfxLoop);var dt=Math.min((now-_loopPrev)/1000,0.1);_loopPrev=now;var phys=window._physics;var player=window._localPlayer;if(!phys||!player||!player.position)return;var grounded=phys.isGrounded?phys.isGrounded():false;var vy=phys.velocityY?phys.velocityY():0;var vx=phys.velocityX?phys.velocityX():0;var vz=phys.velocityZ?phys.velocityZ():0;var hSpd=Math.sqrt(vx*vx+vz*vz);var curY=player.position.y;var yDelta=curY-_prevY;if(!window._gamePaused){if(!_prevGrounded&&grounded&&_prevVY<-3.5){_sfxLand(_prevVY);_walkTimer=0.12;}if(grounded&&hSpd>1.2&&yDelta<0.04){_walkTimer-=dt;if(_walkTimer<=0){_sfxFootstep();_walkTimer=Math.max(0.22,0.43-hSpd*0.025);}}else if(!grounded||hSpd<0.5){_walkTimer=Math.max(0,_walkTimer-dt*4);}}_prevGrounded=grounded;_prevVY=vy;_prevY=curY;})(performance.now());
})();`;

  const multiplayerFn = `
(function(){
  var chatLog=document.getElementById('chat-log');
  var chatInput=document.getElementById('chat-input');
  var chatForm=document.getElementById('chat-form');
  var playerBadge=document.getElementById('player-count');
  var escMenu=document.getElementById('esc-menu');
  var escList=document.getElementById('esc-player-list');
  function addMsg(username,text,isSystem){
    if(!chatLog)return;
    var div=document.createElement('div');
    div.className='chat-msg'+(isSystem?' chat-sys':'');
    if(isSystem){div.textContent=text;}
    else{var nm=document.createElement('span');nm.className='chat-name';nm.textContent=username+': ';div.appendChild(nm);div.appendChild(document.createTextNode(text));}
    chatLog.appendChild(div);
    while(chatLog.children.length>60)chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop=chatLog.scrollHeight;
  }
  function updateBadge(n){if(playerBadge)playerBadge.textContent=n+(n===1?' player':' players');}
  document.addEventListener('keydown',function(e){if(!chatInput||window._gamePaused)return;if(document.activeElement===chatInput)return;if(e.key==='/'){e.preventDefault();if(window._keys){for(var k in window._keys)window._keys[k]=false;}chatInput.focus();}});
  if(chatInput){
    chatInput.addEventListener('focus',function(){if(window._keys){for(var k in window._keys)window._keys[k]=false;}});
    ['keydown','keyup','keypress'].forEach(function(evt){chatInput.addEventListener(evt,function(e){e.stopPropagation();if(evt==='keydown'&&e.key==='Escape'){chatInput.blur();chatInput.value='';}});});
  }
  if(chatForm){chatForm.addEventListener('submit',function(e){e.preventDefault();var msg=chatInput?chatInput.value.trim():'';if(!msg){chatInput&&chatInput.blur();return;}doSendChat(msg);chatInput.value='';chatInput.blur();});}
  var remotePlayers={};
  var myName=window.PLAYER_NAME||'Player';
  function _esc(str){return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function openEscMenu(){
    if(window._gamePaused)return;
    window._gamePaused=true;
    document.body.style.cursor='';
    var xhEl=document.getElementById('_sl_crosshair');if(xhEl)xhEl.style.display='none';
    if(escMenu)escMenu.classList.add('show');
    renderEscPlayerList();
    var cam=window._camera; var slider=document.getElementById('esc-sens-slider'); var valLbl=document.getElementById('esc-sens-val');
    if(cam&&slider){var sv=Math.round(Math.max(1,Math.min(10,(cam.getSensitivity()||0.003)*1000)));slider.value=sv;if(valLbl)valLbl.textContent=sv;}
  }
  function closeEscMenu(){
    window._gamePaused=false;
    if(escMenu)escMenu.classList.remove('show');
    if(window._camera&&window._camera.isShiftLocked()){document.body.style.cursor='none';var xhEl=document.getElementById('_sl_crosshair');if(xhEl)xhEl.style.display='block';window._camera.resetDeltaOrigin();}
  }
  function renderEscPlayerList(){
    if(!escList)return; escList.innerHTML='';
    var selfEl=document.createElement('div');selfEl.className='esc-player me';
    selfEl.innerHTML='<span class="esc-dot"></span><span class="esc-pname">'+_esc(myName)+'</span><span class="esc-you">you</span>';
    escList.appendChild(selfEl);
    for(var id in remotePlayers){var rp=remotePlayers[id];var el=document.createElement('div');el.className='esc-player';el.innerHTML='<span class="esc-dot"></span><span class="esc-pname">'+_esc(rp.name||'Player')+'</span>';escList.appendChild(el);}
  }
  document.addEventListener('keydown',function(e){if(document.activeElement&&document.activeElement.tagName==='INPUT')return;if(e.key==='Escape'){e.preventDefault();if(window._gamePaused)closeEscMenu();else openEscMenu();}});
  var sensSlider=document.getElementById('esc-sens-slider');
  var sensValLbl=document.getElementById('esc-sens-val');
  var shiftLockBtn=document.getElementById('esc-shiftlock-btn');
  if(sensSlider){sensSlider.addEventListener('input',function(){var v=parseInt(sensSlider.value,10);if(sensValLbl)sensValLbl.textContent=v;if(window._camera)window._camera.setSensitivity(v*0.001);});}
  if(shiftLockBtn){shiftLockBtn.addEventListener('click',function(){if(!window._camera)return;var nowOn=!window._camera.isShiftLocked();window._camera.setShiftLock(nowOn);shiftLockBtn.textContent='Shift Lock: '+(nowOn?'ON':'OFF');if(nowOn)shiftLockBtn.classList.add('active');else shiftLockBtn.classList.remove('active');});}
  var leaveBtn=document.getElementById('esc-leave-btn');
  var respawnBtn=document.getElementById('esc-respawn-btn');
  var resumeBtn=document.getElementById('esc-resume-btn');
  if(leaveBtn)leaveBtn.addEventListener('click',function(){try{window.parent.postMessage({type:'pludo_leave_game'},'*');}catch(_){window.location.href='/games';}});
  if(respawnBtn)respawnBtn.addEventListener('click',function(){var lp=window._localPlayer;var sp=window._spawnPoint||{x:0,y:0,z:0};if(lp)lp.position.set(sp.x,sp.y,sp.z);if(window._physics)window._physics.reset();closeEscMenu();});
  if(resumeBtn)resumeBtn.addEventListener('click',closeEscMenu);
  var escOverlay=document.getElementById('esc-overlay');
  if(escOverlay)escOverlay.addEventListener('click',closeEscMenu);

  // ── Label / bubble system ──
  var _labelRoot=document.getElementById('rp-labels');
  var _projVec=new THREE.Vector3(), _camFwd=new THREE.Vector3();
  function _makeLabel(name){
    var wrap=document.createElement('div');wrap.className='rp-wrap';
    var bubble=document.createElement('div');bubble.className='rp-bubble';
    var nameEl=document.createElement('div');nameEl.className='rp-name';nameEl.textContent=name;
    wrap.appendChild(bubble);wrap.appendChild(nameEl);
    if(_labelRoot)_labelRoot.appendChild(wrap);
    return{wrap:wrap,bubble:bubble,bubbleTimer:null};
  }
  var _localLabel=_makeLabel(myName),_localBubbleTimer=null;
  function showLocalBubble(text){_localLabel.bubble.textContent=text;_localLabel.bubble.style.display='block';if(_localBubbleTimer)clearTimeout(_localBubbleTimer);_localBubbleTimer=setTimeout(function(){_localLabel.bubble.style.display='none';},5000);}
  function showBubble(rp,text){if(!rp||!rp.bubbleEl)return;rp.bubbleEl.textContent=text;rp.bubbleEl.style.display='block';if(rp.bubbleTimer)clearTimeout(rp.bubbleTimer);rp.bubbleTimer=setTimeout(function(){rp.bubbleEl.style.display='none';},5000);}
  function _updateLabels(){
    var cam=window._camera&&window._camera.camera;if(!cam)return;
    _camFwd.set(0,0,-1).applyQuaternion(cam.quaternion);
    for(var id in remotePlayers){var rp=remotePlayers[id];if(!rp.labelWrap||!rp.group)continue;_projVec.set(rp.group.position.x,rp.group.position.y+2.8,rp.group.position.z);var dx=_projVec.x-cam.position.x,dy=_projVec.y-cam.position.y,dz=_projVec.z-cam.position.z;var inFront=dx*_camFwd.x+dy*_camFwd.y+dz*_camFwd.z>0;if(!inFront){rp.labelWrap.style.display='none';continue;}_projVec.project(cam);var sx=(_projVec.x*0.5+0.5)*window.innerWidth;var sy=(-_projVec.y*0.5+0.5)*window.innerHeight;rp.labelWrap.style.display='';rp.labelWrap.style.left=sx+'px';rp.labelWrap.style.top=sy+'px';}
    var lp=window._localPlayer;if(lp){_projVec.set(lp.position.x,lp.position.y+2.8,lp.position.z);var ldx=_projVec.x-cam.position.x,ldy=_projVec.y-cam.position.y,ldz=_projVec.z-cam.position.z;var lInFront=ldx*_camFwd.x+ldy*_camFwd.y+ldz*_camFwd.z>0;if(!lInFront){_localLabel.wrap.style.display='none';}else{_projVec.project(cam);var lsx=(_projVec.x*0.5+0.5)*window.innerWidth;var lsy=(-_projVec.y*0.5+0.5)*window.innerHeight;_localLabel.wrap.style.display='';_localLabel.wrap.style.left=lsx+'px';_localLabel.wrap.style.top=lsy+'px';}}
  }
  var _rafPrev=performance.now();
  (function _loop(now){var dt=Math.min((now-_rafPrev)/1000,0.1);_rafPrev=now;for(var id in remotePlayers){var rp=remotePlayers[id];if(rp.group&&rp.group.update)rp.group.update(dt);}_updateLabels();requestAnimationFrame(_loop);})(performance.now());

  // ── WebSocket multiplayer ──
  var ws=null,myId=null;
  var myAvatar=window.AVATAR_CONFIG||{};
  var gameId=window.GAME_ID;
  var wsUrl=window.GAME_WS_URL;
  function doSendChat(message){showLocalBubble(message);if(ws&&ws.readyState===1){ws.send(JSON.stringify({type:'chat',message:message}));}else{addMsg(myName,message,false);}}
  function countPlayers(){return Object.keys(remotePlayers).length+1;}
  function spawnRemote(data){requestAnimationFrame(function(){var sc=window._gameScene;if(!sc)return;var savedCfg=window.AVATAR_CONFIG;window.AVATAR_CONFIG=data.avatarConfig||savedCfg;var g=buildAvatar(sc,data.x||0,data.y||0,data.z||0);window.AVATAR_CONFIG=savedCfg;var lbl=_makeLabel(data.username||'Player');remotePlayers[data.id]={group:g,name:data.username||'Player',t:Date.now(),labelWrap:lbl.wrap,bubbleEl:lbl.bubble,bubbleTimer:null};updateBadge(countPlayers());});}
  function despawnRemote(id){var rp=remotePlayers[id];if(!rp)return;var sc=window._gameScene;if(sc)sc.remove(rp.group);if(rp.labelWrap&&rp.labelWrap.parentNode)rp.labelWrap.parentNode.removeChild(rp.labelWrap);if(rp.bubbleTimer)clearTimeout(rp.bubbleTimer);delete remotePlayers[id];updateBadge(countPlayers());}
  function moveRemote(id,x,y,z,rotY){var rp=remotePlayers[id];if(!rp)return;rp.group.position.set(x,y,z);rp.group.rotation.y=rotY||0;rp.t=Date.now();}
  if(!gameId||!wsUrl){updateBadge(1);return;}
  var _posTimer=null;
  function connect(){
    try{ws=new WebSocket(wsUrl+'?gameId='+gameId);}catch(_){return;}
    ws.onopen=function(){ws.send(JSON.stringify({type:'join',username:myName,avatarConfig:myAvatar}));_posTimer=setInterval(function(){var lp=window._localPlayer;if(!lp||ws.readyState!==1)return;ws.send(JSON.stringify({type:'move',x:lp.position.x,y:lp.position.y,z:lp.position.z,rotY:lp.rotation?lp.rotation.y:0}));},50);};
    ws.onmessage=function(ev){var msg;try{msg=JSON.parse(ev.data);}catch(_){return;}if(msg.type==='joined'){myId=msg.playerId;(msg.players||[]).forEach(spawnRemote);updateBadge(countPlayers());addMsg('','Connected — '+countPlayers()+' player(s) in this game.',true);}else if(msg.type==='player_join'){spawnRemote(msg);addMsg('',msg.username+' joined the game.',true);}else if(msg.type==='player_leave'){despawnRemote(msg.playerId);}else if(msg.type==='move'){moveRemote(msg.playerId,msg.x,msg.y,msg.z,msg.rotY);}else if(msg.type==='chat'){addMsg(msg.username,msg.message,false);showBubble(remotePlayers[msg.playerId],msg.message);}};
    ws.onclose=function(){clearInterval(_posTimer);setTimeout(connect,3000);};
    ws.onerror=function(){};
  }
  connect();
})();`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:#0a0a1a;overflow:hidden;touch-action:none;overscroll-behavior:none;}
body{cursor:crosshair;-webkit-user-select:none;user-select:none;}
canvas{display:block;touch-action:none;overscroll-behavior:none;}
#ui{position:fixed;top:16px;left:50%;transform:translateX(-50%);color:#fff;font:bold 20px sans-serif;text-align:center;text-shadow:0 0 10px ${uiColor};pointer-events:none;z-index:10;}
#msg{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:bold 28px sans-serif;text-align:center;display:none;background:rgba(0,0,0,0.75);padding:20px 40px;border-radius:12px;border:2px solid ${uiColor};z-index:10;max-width:80%;}
#instructions{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.5);font:13px sans-serif;text-align:center;pointer-events:none;z-index:10;}
#_err{display:none;position:fixed;top:0;left:0;right:0;background:#c0392b;color:#fff;padding:8px 12px;font:12px monospace;z-index:9999;white-space:pre-wrap;max-height:40%;overflow-y:auto;}
#chat-wrap{position:fixed;top:10px;left:10px;width:260px;z-index:50;display:flex;flex-direction:column;gap:0;pointer-events:none;font-family:sans-serif;}
#chat-header{display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.60);border-radius:8px 8px 0 0;padding:4px 8px;}
#player-count{color:rgba(255,255,255,0.7);font-size:11px;}
#chat-log{background:rgba(0,0,0,0.50);padding:6px 8px;max-height:150px;min-height:24px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;}
#chat-log::-webkit-scrollbar{width:3px;}
#chat-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:2px;}
.chat-msg{font-size:12px;color:#e8e8e8;line-height:1.4;word-break:break-word;}
.chat-msg .chat-name{font-weight:700;color:#bb88ff;}
.chat-sys{color:rgba(255,255,255,0.45);font-style:italic;}
#chat-form{display:flex;gap:0;pointer-events:all;}
#chat-input{flex:1;background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.18);border-right:none;color:#fff;padding:5px 8px;border-radius:0 0 0 8px;font-size:12px;outline:none;caret-color:#bb88ff;}
#chat-input::placeholder{color:rgba(255,255,255,0.3);}
#chat-input:focus{border-color:rgba(176,38,255,0.6);background:rgba(0,0,0,0.85);}
#chat-send{background:rgba(136,68,255,0.8);border:1px solid rgba(136,68,255,0.6);border-left:none;color:#fff;padding:5px 10px;border-radius:0 0 8px 0;font-size:14px;cursor:pointer;}
#esc-menu{display:none;position:fixed;inset:0;z-index:500;align-items:center;justify-content:center;}
#esc-menu.show{display:flex;}
#esc-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);}
#esc-panel{position:relative;z-index:1;background:linear-gradient(155deg,#0d0920 0%,#180d32 100%);border:1px solid rgba(136,68,255,0.45);border-radius:20px;padding:28px 24px;width:320px;max-width:90vw;box-shadow:0 0 60px rgba(136,68,255,0.2),inset 0 1px 0 rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:18px;}
#esc-title{font:bold 22px sans-serif;color:#fff;text-align:center;letter-spacing:0.02em;}
.esc-section-label{font:700 11px sans-serif;color:rgba(255,255,255,0.4);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;}
#esc-player-list{display:flex;flex-direction:column;gap:6px;max-height:120px;overflow-y:auto;}
.esc-player{display:flex;align-items:center;gap:8px;padding:4px 0;}
.esc-dot{width:8px;height:8px;border-radius:50%;background:#44ee88;flex-shrink:0;}
.esc-pname{font:14px sans-serif;color:#fff;}
.esc-you{margin-left:auto;font:11px sans-serif;color:rgba(255,255,255,0.4);}
.esc-setting-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.esc-setting-label{font:13px sans-serif;color:rgba(255,255,255,0.7);min-width:80px;}
#esc-sens-slider{flex:1;accent-color:#8844ff;}
#esc-sens-val{font:13px monospace;color:#fff;min-width:18px;text-align:right;}
#esc-shiftlock-btn{flex:1;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 12px;border-radius:8px;font:13px sans-serif;cursor:pointer;}
#esc-shiftlock-btn.active{background:rgba(136,68,255,0.3);border-color:rgba(136,68,255,0.6);}
#esc-buttons{display:flex;gap:10px;justify-content:space-between;}
#esc-leave-btn,#esc-respawn-btn,#esc-resume-btn{flex:1;padding:12px 8px;border-radius:12px;font:bold 13px sans-serif;cursor:pointer;border:none;transition:opacity 0.15s;}
#esc-leave-btn{background:rgba(255,69,58,0.25);color:#ff4542;border:1px solid rgba(255,69,58,0.4);}
#esc-respawn-btn{background:rgba(255,149,0,0.2);color:#ff9500;border:1px solid rgba(255,149,0,0.4);}
#esc-resume-btn{background:rgba(68,238,136,0.2);color:#44ee88;border:1px solid rgba(68,238,136,0.4);}
#rp-labels{position:fixed;top:0;left:0;pointer-events:none;z-index:30;}
.rp-wrap{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:2px;}
.rp-bubble{background:rgba(0,0,0,0.75);color:#fff;font:12px sans-serif;padding:3px 8px;border-radius:10px;display:none;max-width:160px;text-align:center;word-break:break-word;}
.rp-name{font:bold 11px sans-serif;color:rgba(255,255,255,0.7);}
#mobile-controls{display:none;position:fixed;inset:0;z-index:40;pointer-events:none;}
@media(pointer:coarse){#mobile-controls{display:block;}}
#mb-left-zone{position:absolute;left:0;top:0;width:50%;height:100%;pointer-events:all;}
#mb-right-zone{position:absolute;right:0;top:0;width:50%;height:100%;pointer-events:all;}
#mb-stick-base{display:none;position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);background:rgba(0,0,0,0.3);transform:translate(-50%,-50%);pointer-events:none;}
#mb-stick-thumb{display:none;position:absolute;width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,0.5);transform:translate(-50%,-50%);pointer-events:none;}
#mb-btns{position:absolute;right:20px;bottom:80px;display:flex;flex-direction:column;gap:12px;pointer-events:all;}
.mb-btn{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold 11px sans-serif;color:#fff;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;}
.mb-btn:active{transform:scale(0.92)!important;}
#mb-jump-btn{background:rgba(68,238,136,0.3);border:2px solid rgba(68,238,136,0.6);box-shadow:0 0 15px rgba(68,238,136,0.3);}
#mb-chat-btn{background:rgba(136,68,255,0.3);border:2px solid rgba(136,68,255,0.6);box-shadow:0 0 15px rgba(136,68,255,0.3);}
</style>
</head>
<body>
<div id="chat-wrap">
  <div id="chat-header">
    <span id="player-count">1 player</span>
    <span style="color:rgba(255,255,255,0.28);font-size:10px;">/ to chat</span>
  </div>
  <div id="chat-log"></div>
  <form id="chat-form" autocomplete="off">
    <input id="chat-input" type="text" placeholder="Say something..." maxlength="120" autocomplete="off" />
    <button id="chat-send" type="submit">&#8629;</button>
  </form>
</div>
<div id="esc-menu">
  <div id="esc-overlay"></div>
  <div id="esc-panel">
    <div id="esc-title">&#9646;&#9646; Paused</div>
    <div id="esc-players-section">
      <div class="esc-section-label">Players Online</div>
      <div id="esc-player-list"></div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
    <div id="esc-settings-section">
      <div class="esc-section-label">Camera Settings</div>
      <div class="esc-setting-row">
        <span class="esc-setting-label">Sensitivity</span>
        <input type="range" id="esc-sens-slider" min="1" max="10" step="1" value="3">
        <span id="esc-sens-val">3</span>
      </div>
      <div class="esc-setting-row">
        <span class="esc-setting-label">Shift Lock</span>
        <button id="esc-shiftlock-btn">Shift Lock: OFF</button>
      </div>
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
    <div id="esc-buttons">
      <button id="esc-leave-btn">Leave Game</button>
      <button id="esc-respawn-btn">Respawn</button>
      <button id="esc-resume-btn">Resume</button>
    </div>
  </div>
</div>
<div id="mobile-controls">
  <div id="mb-left-zone"></div>
  <div id="mb-stick-base"></div>
  <div id="mb-stick-thumb"></div>
  <div id="mb-right-zone"></div>
  <div id="mb-btns">
    <div id="mb-jump-btn" class="mb-btn">JUMP</div>
    <div id="mb-chat-btn" class="mb-btn">CHAT</div>
  </div>
</div>
<div id="rp-labels"></div>
<div id="ui">Score: <span id="score">0</span></div>
<div id="msg"></div>
<div id="instructions"></div>
<div id="_err"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" crossorigin="anonymous"></script>
<script>
window.addEventListener('error',function(e){if(!e.message||e.message==='Script error.'||(e.lineno===0&&!e.filename))return;var el=document.getElementById('_err');if(el){el.style.display='block';var loc=e.filename?e.filename.split('/').pop()+':'+e.lineno:'line '+e.lineno;el.textContent+='ERROR: '+e.message+' ('+loc+')\\n';}});
window.addEventListener('unhandledrejection',function(e){var msg=e.reason&&e.reason.message?e.reason.message:String(e.reason);if(!msg||msg==='undefined')return;var el=document.getElementById('_err');if(el){el.style.display='block';el.textContent+='UNHANDLED: '+msg+'\\n';}});

${setupSceneFn}
${setupCameraFn}
${setupPhysicsFn}
${buildAvatarFn}

window._collidables = window._collidables || [];
window._spawnPoint  = window._spawnPoint  || {x:0,y:0,z:0};
window._gamePaused  = false;
window._keys        = window._keys || {};

window.saveProgress=function(data){try{localStorage.setItem('gf_progress_'+window.GAME_ID,JSON.stringify(data));}catch(e){}};
window.loadProgress=function(){try{var d=localStorage.getItem('gf_progress_'+window.GAME_ID);return d?JSON.parse(d):null;}catch(e){return null;}};
window.GAME_PROGRESS=window.loadProgress();

function _startWhenReady(fn){if(window.innerWidth>0&&window.innerHeight>0){fn();}else{requestAnimationFrame(function(){_startWhenReady(fn);});}}

${soundEngineFn}

_startWhenReady(function(){
// === GAME_LOGIC_START ===
${gameLogic}
// === GAME_LOGIC_END ===

${multiplayerFn}

// Mobile controls
(function(){
  window.addEventListener('popstate',function(){try{window.parent.postMessage({type:'pludo_leave_game'},'*');}catch(_){window.location.href='/games';}});
  try{history.pushState(null,'',location.href);}catch(_){}
  if(!window.matchMedia('(pointer:coarse)').matches)return;
  var leftZone=document.getElementById('mb-left-zone');
  var rightZone=document.getElementById('mb-right-zone');
  var stickBase=document.getElementById('mb-stick-base');
  var stickThumb=document.getElementById('mb-stick-thumb');
  var jumpBtn=document.getElementById('mb-jump-btn');
  var chatBtn=document.getElementById('mb-chat-btn');
  var _stickActive=false,_stickStartX=0,_stickStartY=0,_stickTouchId=-1,STICK_RADIUS=40;
  function _stickInput(nx,nz){if(window._mobileInput){window._mobileInput.x=nx;window._mobileInput.z=nz;}if(window._keys){window._keys['w']=nz<-0.25;window._keys['s']=nz>0.25;window._keys['a']=nx<-0.25;window._keys['d']=nx>0.25;}}
  function _stickRelease(){_stickActive=false;_stickTouchId=-1;if(stickBase)stickBase.style.display='none';if(stickThumb)stickThumb.style.display='none';_stickInput(0,0);}
  if(leftZone){
    leftZone.addEventListener('touchstart',function(e){e.preventDefault();var t=e.changedTouches[0];_stickActive=true;_stickTouchId=t.identifier;_stickStartX=t.clientX;_stickStartY=t.clientY;if(stickBase){stickBase.style.left=t.clientX+'px';stickBase.style.top=t.clientY+'px';stickBase.style.display='block';}if(stickThumb){stickThumb.style.left=t.clientX+'px';stickThumb.style.top=t.clientY+'px';stickThumb.style.display='block';}},{passive:false});
    leftZone.addEventListener('touchmove',function(e){e.preventDefault();if(!_stickActive)return;for(var i=0;i<e.changedTouches.length;i++){var t=e.changedTouches[i];if(t.identifier!==_stickTouchId)continue;var dx=t.clientX-_stickStartX,dy=t.clientY-_stickStartY;var len=Math.sqrt(dx*dx+dy*dy);var clamped=Math.min(len,STICK_RADIUS);var nx=len>0?dx/len:0,nz=len>0?dy/len:0;if(stickThumb){stickThumb.style.left=(_stickStartX+nx*clamped)+'px';stickThumb.style.top=(_stickStartY+nz*clamped)+'px';}_stickInput(nx*Math.min(len/STICK_RADIUS,1),nz*Math.min(len/STICK_RADIUS,1));}},{passive:false});
    leftZone.addEventListener('touchend',function(e){for(var i=0;i<e.changedTouches.length;i++){if(e.changedTouches[i].identifier===_stickTouchId){_stickRelease();break;}}},{passive:false});
    leftZone.addEventListener('touchcancel',function(){_stickRelease();},{passive:false});
  }
  var _camTouchId=-1,_camLastX=0,_camLastY=0;
  if(rightZone){
    rightZone.addEventListener('touchstart',function(e){e.preventDefault();var t=e.changedTouches[0];_camTouchId=t.identifier;_camLastX=t.clientX;_camLastY=t.clientY;},{passive:false});
    rightZone.addEventListener('touchmove',function(e){e.preventDefault();if(!window._camera)return;for(var i=0;i<e.changedTouches.length;i++){var t=e.changedTouches[i];if(t.identifier!==_camTouchId)continue;var dx=t.clientX-_camLastX,dy=t.clientY-_camLastY;_camLastX=t.clientX;_camLastY=t.clientY;var sens=window._camera.getSensitivity?window._camera.getSensitivity():0.003;if(window._camera.touchOrbit)window._camera.touchOrbit(-dx,-dy,sens);}},{passive:false});
    rightZone.addEventListener('touchend',function(e){for(var i=0;i<e.changedTouches.length;i++){if(e.changedTouches[i].identifier===_camTouchId){_camTouchId=-1;break;}}},{passive:false});
    rightZone.addEventListener('touchcancel',function(){_camTouchId=-1;},{passive:false});
  }
  if(jumpBtn){jumpBtn.addEventListener('touchstart',function(e){e.preventDefault();document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));},{passive:false});jumpBtn.addEventListener('touchend',function(e){e.preventDefault();document.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true}));},{passive:false});}
  if(chatBtn){chatBtn.addEventListener('touchstart',function(e){e.preventDefault();var ci=document.getElementById('chat-input');if(ci){if(window._keys){for(var k in window._keys)window._keys[k]=false;}ci.focus();}},{passive:false});}
  window._mobileInput=window._mobileInput||{x:0,z:0};
})();
});
</script>
</body>
</html>`;
}
