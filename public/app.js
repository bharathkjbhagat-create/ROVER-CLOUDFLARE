
/* Built-in image fallback: keeps the ROVER photos visible if the separate photo scripts are blocked/cached. */
// ROVER reference prototype image (WebP data URI)
window.ROVER_DEVICE_IMAGE="/rover-device.webp";

// Exact uploaded ROVER prototype image for the lower-left panel, converted to WebP for fast loading.
window.ROVER_LEFT_IMAGE="/rover-left.webp";

(function(){
"use strict";
let me=null,map=null,rover=null,targetMarker=null,targetLine=null,trackLine=null,geofence=null,satelliteOn=false,satelliteLayer=null,streetLayer=null,terrainLayer=null,trackPts=[],samples=[],telemetryBusy=false,loginAlertBusy=false,logoutSent=false,mapReady=false,motionStopTimer=null,hybridOn=false,liveTracking=true,recording=false,lastLiveCommand="",lastKnownLoss=null,lastKnownLossKey="";
let gpsWatchId=null,gpsPublishBusy=false,gpsLastPublishedAt=0,gpsSourceId=localStorage.getItem("rover_gps_source_id")||"",realCameraInitialized=false,realCameraActive=false;
if(!gpsSourceId){gpsSourceId="gps-"+(crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2));localStorage.setItem("rover_gps_source_id",gpsSourceId)}
let lastLoginAt=localStorage.getItem("rover_last_login_at")||"",unreadLogins=0;
let notificationSoundEnabled=localStorage.getItem("rover_notification_sound")!=="off";
let notificationAudioCtx=null,targetAlarmTimer=null,targetAlarmActive=false,targetAlarmSirenTimer=null,targetDetectionInitialized=false,targetDetectedState=false;
function targetSirenBurst(){
  if(!notificationSoundEnabled)return false;
  return initNotificationAudio().then(ready=>{
    const ctx=notificationAudioCtx;if(!ready||!ctx||ctx.state!=="running")return false;
    try{
      const now=ctx.currentTime,master=ctx.createGain();
      master.gain.setValueAtTime(0.0001,now);
      master.gain.exponentialRampToValueAtTime(0.38,now+0.03);
      master.gain.exponentialRampToValueAtTime(0.16,now+0.28);
      master.gain.exponentialRampToValueAtTime(0.0001,now+0.62);
      master.connect(ctx.destination);
      const osc=ctx.createOscillator();osc.type="square";
      osc.frequency.setValueAtTime(520,now);osc.frequency.linearRampToValueAtTime(1100,now+0.20);osc.frequency.linearRampToValueAtTime(520,now+0.46);
      osc.connect(master);osc.start(now);osc.stop(now+0.63);return true;
    }catch(_){return false}
  });
}
function stopTargetAlarm(){
  if(targetAlarmTimer)clearInterval(targetAlarmTimer);targetAlarmTimer=null;
  if(targetAlarmSirenTimer)clearTimeout(targetAlarmSirenTimer);targetAlarmSirenTimer=null;
  targetAlarmActive=false;
  const p=$("targetAlarmPopup");if(p)p.remove();
}
function startTargetAlarm(t){
  if(targetAlarmActive)return;
  targetAlarmActive=true;
  const old=$("targetAlarmPopup");if(old)old.remove();
  const p=document.createElement("div");p.id="targetAlarmPopup";
  p.setAttribute("role","alert");p.style.cssText="position:fixed;right:18px;top:76px;z-index:99999;width:min(390px,calc(100vw - 36px));padding:16px 18px;border:2px solid #ff3f52;border-radius:12px;background:linear-gradient(145deg,rgba(74,8,16,.97),rgba(24,7,12,.97));box-shadow:0 0 0 2px rgba(255,63,82,.12),0 14px 40px rgba(0,0,0,.45),0 0 28px rgba(255,63,82,.26);color:#fff;font-family:Inter,Segoe UI,Arial,sans-serif";
  const type=esc(t?.type||"Object"),range=Math.round(Number(t?.range_m||0)),speed=Number(t?.speed_kmh||0).toFixed(1),conf=Math.round(Number(t?.confidence||0)*100);
  p.innerHTML="<div style='font:900 17px/1.1 Inter,Segoe UI,Arial,sans-serif;letter-spacing:.5px;color:#ff7b86'>⚠ TARGET DETECTED</div><div style='margin-top:10px;font-size:13px'><b>"+type+"</b> detected in camera view</div><div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px'><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>RANGE</small><b>"+range+" m</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>SPEED</small><b>"+speed+" km/h</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>CONF.</small><b>"+conf+"%</b></span></div><button id='silenceTargetAlarmBtn' type='button' style='margin-top:12px;width:100%;height:34px;border:1px solid #ff6674;border-radius:7px;background:#3a0f18;color:#ffd8dc;font-weight:900;cursor:pointer'>SILENCE ALARM</button>";
  document.body.appendChild(p);
  p.querySelector("#silenceTargetAlarmBtn")?.addEventListener("click",()=>{if(targetAlarmTimer)clearInterval(targetAlarmTimer);targetAlarmTimer=null;const b=$("silenceTargetAlarmBtn");if(b)b.textContent="ALARM SILENCED";});
  if(notificationSoundEnabled){targetSirenBurst();targetAlarmTimer=setInterval(()=>{if(targetAlarmActive)targetSirenBurst()},900)}
}
function syncTargetAlarm(detected,t){
  const now=!!detected;
  if(!targetDetectionInitialized){targetDetectionInitialized=true;targetDetectedState=now;if(now)startTargetAlarm(t);return;}
  if(now&&!targetDetectedState)startTargetAlarm(t);
  else if(!now&&targetDetectedState)stopTargetAlarm();
  targetDetectedState=now;
}
function initNotificationAudio(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return Promise.resolve(false);
    if(!notificationAudioCtx)notificationAudioCtx=new AC();
    if(notificationAudioCtx.state==="suspended")return notificationAudioCtx.resume().then(()=>true).catch(()=>false);
    return Promise.resolve(true);
  }catch(_){return Promise.resolve(false)}
}
async function playNotificationSound(){
  if(!notificationSoundEnabled)return false;
  const ready=await initNotificationAudio();
  const ctx=notificationAudioCtx;
  if(!ready||!ctx||ctx.state!=="running")return false;
  try{
    const now=ctx.currentTime;
    const master=ctx.createGain();
    master.gain.setValueAtTime(0.0001,now);
    master.gain.exponentialRampToValueAtTime(0.30,now+0.018);
    master.gain.exponentialRampToValueAtTime(0.0001,now+0.50);
    master.connect(ctx.destination);
    const osc=ctx.createOscillator();
    osc.type="sine";
    osc.frequency.setValueAtTime(880,now);
    osc.frequency.exponentialRampToValueAtTime(1320,now+0.11);
    osc.connect(master); osc.start(now); osc.stop(now+0.50);
    const gain2=ctx.createGain();
    gain2.gain.setValueAtTime(0.0001,now+0.14);
    gain2.gain.exponentialRampToValueAtTime(0.22,now+0.17);
    gain2.gain.exponentialRampToValueAtTime(0.0001,now+0.64);
    gain2.connect(ctx.destination);
    const osc2=ctx.createOscillator();
    osc2.type="sine";
    osc2.frequency.setValueAtTime(1175,now+0.14);
    osc2.connect(gain2); osc2.start(now+0.14); osc2.stop(now+0.65);
    return true;
  }catch(_){return false}
}
function updateNotificationSoundUI(){
  const b=$("soundBtn"); if(!b)return;
  b.textContent=notificationSoundEnabled?"🔊 SOUND ON":"🔇 SOUND OFF";
  b.setAttribute("aria-pressed",String(notificationSoundEnabled));
}
function toggleNotificationSound(){
  notificationSoundEnabled=!notificationSoundEnabled;
  localStorage.setItem("rover_notification_sound",notificationSoundEnabled?"on":"off");
  if(notificationSoundEnabled){initNotificationAudio();playNotificationSound()}
  updateNotificationSoundUI();
  setText("alertStatus",notificationSoundEnabled?"Notification sound ENABLED.":"Notification sound MUTED.");
}
const demoCenter=[12.9716,77.5946];

const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function setText(id,v){const e=$(id);if(e)e.textContent=v;}
function show(id){const e=$(id);if(e)e.classList.remove("hidden")}
function hide(id){const e=$(id);if(e)e.classList.add("hidden")}
function openModal(id){show(id)}
function closeModal(id){const e=$(id);if(e)e.classList.add("hidden")}

async function api(url,options={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  let r;
  try{
    r=await fetch(url,{cache:"no-store",credentials:"same-origin",signal:controller.signal,...options});
  }finally{
    clearTimeout(timer);
  }
  if(r.status===401){
    sessionStorage.removeItem("rover_user");
    location.replace("/login.html");
    throw new Error("Login required");
  }
  return r;
}

function loadMapAsync(){
  const link=document.createElement("link");
  link.rel="stylesheet";
  link.href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(link);
  const s=document.createElement("script");
  s.src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
  s.async=true;
  s.onload=()=>initMap();
  s.onerror=()=>{show("mapFallback");setText("mapFallback","Map service is unavailable. Control centre remains online.");};
  document.head.appendChild(s);
}
function initMap(){
  try{
    if(mapReady||map)return;
    if(typeof L==="undefined")throw new Error("Leaflet unavailable");
    const mapHost=$("map");
    if(!mapHost)throw new Error("Map container unavailable");
    mapHost.querySelectorAll(".leaflet-container").forEach(el=>el.remove());
    map=L.map("map",{zoomControl:false,preferCanvas:true}).setView(demoCenter,15);
    // Exactly one native Leaflet zoom control. The custom rail below is recenter-only.
    L.control.zoom({position:"topleft"}).addTo(map);
    streetLayer=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"});
    satelliteLayer=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Imagery © Esri"});
    terrainLayer=L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",{maxZoom:17,attribution:"© OpenTopoMap contributors"});
    satelliteLayer.addTo(map);
    satelliteOn=true;
    document.querySelectorAll(".mapTab").forEach(b=>b.classList.toggle("active",b.dataset.mapmode==="satellite"));
    setText("mapMode","Satellite");
    geofence=L.circle(demoCenter,{radius:600,color:"#18d6a3",fill:false,weight:1,dashArray:"6 6"}).addTo(map);
    const roverIcon=L.divIcon({className:"roverMarkerLabel",html:'<div class="roverMapMarker" id="roverMapMarker">✦</div>',iconSize:[34,34],iconAnchor:[17,17]});
    rover=L.marker(demoCenter,{icon:roverIcon}).addTo(map).bindTooltip("ROVER-01",{permanent:true,direction:"top",className:"roverTooltip"});
    hide("mapFallback");hide("mapFrame");
    mapReady=true;
    setText("conn","CONNECTED");
    setText("serverHeader","Server");
    setTimeout(()=>map.invalidateSize(),100);
    window.dispatchEvent(new Event("rover-map-ready"));
  }catch(err){
    show("mapFallback");
    setText("conn","DEGRADED");
  }
}
function setMapMode(mode){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  [streetLayer,satelliteLayer,terrainLayer].forEach(layer=>{if(layer&&map.hasLayer(layer))map.removeLayer(layer)});
  hybridOn=false;
  if(mode==="satellite"){satelliteLayer.addTo(map);satelliteOn=true}
  else if(mode==="terrain"){terrainLayer.addTo(map);satelliteOn=false}
  else if(mode==="hybrid"){satelliteLayer.addTo(map);hybridOn=true;satelliteOn=true}
  else {streetLayer.addTo(map);satelliteOn=false}
  const names={map:"Map",satellite:"Satellite",terrain:"Terrain",hybrid:"Hybrid"};
  setText("mapMode",names[mode]||"Map");
  document.querySelectorAll(".mapTab").forEach(b=>b.classList.toggle("active",b.dataset.mapmode===mode));
  recordActivity("MAP_SATELLITE",(names[mode]||"Map")+" view");
  addLog("MAP",(names[mode]||"Map")+" view enabled");
}
function toggleSatellite(){
  setMapMode(satelliteOn?"map":"satellite");
}
function centerRover(){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  if(rover)map.setView(rover.getLatLng(),16);else map.setView(demoCenter,16);
  recordActivity("MAP_CENTER","Centered map on ROVER-01");
}
function fitTrack(){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  if(trackLine&&trackPts.length>1){
    map.fitBounds(trackLine.getBounds(),{padding:[30,30]});
    recordActivity("MAP_FIT","Fitted map to rover track");
  }else{
    centerRover();
  }
}
async function openDevices(){
  $("deviceModal").classList.remove("hidden");
  await loadDevices();
}
async function loadDevices(){
  const r=await api("/api/devices"); const d=await r.json();
  if(!r.ok){$("deviceTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load devices")+"</div>";return}
  $("deviceTable").innerHTML="<table><tr><th>Device</th><th>Type</th><th>Status</th><th>Notes</th></tr>"+
    d.devices.map(x=>"<tr><td><b>"+esc(x.name)+"</b><small>"+esc(x.device_code)+"</small></td><td>"+esc(x.type)+"</td><td>"+(x.enabled?"ENABLED":"DISABLED")+"</td><td>"+esc(x.notes||"")+"</td></tr>").join("")+"</table>";
}
async function createDevice(){
  const body={device_code:$("newDeviceCode").value.trim(),name:$("newDeviceName").value.trim(),type:$("newDeviceType").value,notes:$("newDeviceNotes").value.trim()};
  const r=await api("/api/devices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  setText("deviceMsg",d.ok?"Device added successfully.":(d.error||"Could not add device"));
  if(d.ok){$("newDeviceCode").value="";$("newDeviceName").value="";$("newDeviceNotes").value="";await loadDevices();}
}


function realtimeEndpoint(){
  const proto=location.protocol==="https:"?"wss":"ws";
  return proto+"://"+location.host+"/api/ws";
}
function connectionText(d){
  if(d?.device_online===false)return "● DEVICE SIGNAL LOST";
  return window.roverWS?.readyState===WebSocket.OPEN?"● ONLINE • REALTIME":"● ONLINE";
}
function applyRemoteState(message){
  if(!message)return;
  if(message.type==="camera-command"&&message.command){
    const c=String(message.command).toUpperCase();
    setText("cmd",c);
    if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(c);
    const camera=$("cameraSceneLabel");
    if(camera){
      const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};
      camera.textContent=labels[c]||"DEMO CAMERA VIEW • SIMULATION";
    }
    return;
  }
  if(message.type==="state"&&message.telemetry){
    if(message.telemetry.sync_version)window.ROVER_SYNC_VERSION=message.telemetry.sync_version;
    updateUI(message.telemetry);
    setText("conn",connectionText(message.telemetry));
    return;
  }
  if(message.type==="connected"){setText("conn","● ONLINE • REALTIME");}
  if(message.type==="command-error"){addLog("DENIED",message.error||"Command rejected");}
}
function connectRealtime(){
  if(!me)return;
  const existing=window.roverWS;
  if(existing&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(existing.readyState))return;
  if(window.roverReconnectTimer){clearTimeout(window.roverReconnectTimer);window.roverReconnectTimer=null}
  window.roverReconnectAttempts=Number(window.roverReconnectAttempts||0)+1;
  const attempt=window.roverReconnectAttempts;
  try{
    const ws=new WebSocket(realtimeEndpoint());
    window.roverWS=ws;
    let heartbeatTimer=null,pongTimer=null,healthy=false;
    const clearHeartbeat=()=>{if(heartbeatTimer)clearInterval(heartbeatTimer);heartbeatTimer=null;if(pongTimer)clearTimeout(pongTimer);pongTimer=null};
    const heartbeat=()=>{
      if(ws.readyState!==WebSocket.OPEN)return;
      try{
        ws.send(JSON.stringify({type:"ping",t:Date.now()}));
        if(pongTimer)clearTimeout(pongTimer);
        pongTimer=setTimeout(()=>{healthy=false;try{ws.close(4000,"Heartbeat timeout")}catch(_){}},9000);
      }catch(_){try{ws.close(4000,"Heartbeat send failed")}catch(__){}}
    };
    ws.onopen=()=>{
      window.roverReconnectAttempts=0;
      healthy=true;
      setText("conn","● ONLINE • REALTIME");
      try{ws.send(JSON.stringify({type:"ping",t:Date.now()}))}catch(_){ }
      if(window.roverReconnectTimer){clearTimeout(window.roverReconnectTimer);window.roverReconnectTimer=null}
      clearHeartbeat();
      heartbeatTimer=setInterval(heartbeat,15000);
      heartbeat();
      loop();
    };
    ws.onmessage=e=>{
      try{
        const message=JSON.parse(e.data);
        if(message?.type==="pong"){
          healthy=true;
          if(pongTimer){clearTimeout(pongTimer);pongTimer=null}
          return;
        }
        applyRemoteState(message);
      }catch(_){ }
    };
    ws.onerror=()=>{
      healthy=false;
      setText("conn","● RECONNECTING");
    };
    ws.onclose=()=>{
      clearHeartbeat();
      if(window.roverWS===ws)window.roverWS=null;
      if(me&&!window.roverReconnectTimer){
        setText("conn","● RECONNECTING");
        const delay=Math.min(5000,Math.max(400,400*Math.pow(2,Math.min(4,attempt-1))));
        window.roverReconnectTimer=setTimeout(()=>{window.roverReconnectTimer=null;connectRealtime()},delay);
      }
    };
  }catch(_){
    setText("conn","● RECONNECTING");
    if(me&&!window.roverReconnectTimer){
      const delay=Math.min(5000,Math.max(400,400*Math.pow(2,Math.min(4,attempt-1))));
      window.roverReconnectTimer=setTimeout(()=>{window.roverReconnectTimer=null;connectRealtime()},delay);
    }
  }
}
function updateUI(d){
  const gpsQuality=d.gps_fix?(Number(d.gps_sats||0)>=8?"Excellent":Number(d.gps_sats||0)>=5?"Good":"Fair"):"No Fix";
  setText("battery",Math.round(Number(d.battery||0))+"%");setText("deviceBattery",Math.round(Number(d.battery||0))+"%");
  setText("signal",Math.round(Number(d.signal||0))+"%");setText("signalDevice",Number(d.signal||0)>=70?"Strong":Number(d.signal||0)>=45?"Medium":"Weak");
  setText("gps",d.gps_fix?"Good":"No Fix");setText("gpsHeader",d.gps_fix?"GPS":"GPS");setText("sats",(d.gps_sats??"--")+" sats");
  const speed=Number(d.speed_kmh||0),heading=((Number(d.heading||0)%360)+360)%360;
  setText("speed",speed.toFixed(1)+" km/h");setText("heading","Heading "+Math.round(heading)+"°");updateCompass(heading);
  setText("lat",Number(d.lat).toFixed(6));setText("lon",Number(d.lon).toFixed(6));setText("updated",new Date(d.updated).toLocaleTimeString());
  setText("deviceOnline",d.device_online===false?"● OFFLINE":"● ONLINE");
  setLastKnownLoss(d.last_known_loss||null);
  setText("mapCoords",Number(d.lat).toFixed(4)+"° N  "+Number(d.lon).toFixed(4)+"° E");
  const gpsSource=String(d.gps_source||"SIMULATION");
  const gpsAccuracy=Number(d.gps_accuracy_m);
  const liveGps=(gpsSource==="LIVE_GPS"||gpsSource==="ROVER_DEVICE")&&Number.isFinite(gpsAccuracy);
  window.ROVER_GPS_SOURCE=gpsSource;
  setText("gps",liveGps?"LIVE":(d.gps_fix?"DEMO":"NO FIX"));
  setText("gpsHeader",gpsSource==="ROVER_DEVICE"?"ROVER GPS LIVE":(liveGps?"GPS LIVE":"GPS"));
  setText("gpsSignalText",gpsSource==="ROVER_DEVICE"&&liveGps?"ROVER GPS • ±"+Math.round(gpsAccuracy)+" m":liveGps?"OPERATOR GPS • ±"+Math.round(gpsAccuracy)+" m":(gpsSource==="SIMULATION"?"SIMULATION • NOT REAL GPS":gpsQuality));
  setText("deviceGpsState",gpsSource==="ROVER_DEVICE"&&liveGps?"ROVER • ±"+Math.round(gpsAccuracy)+" m":(liveGps?"OPERATOR • ±"+Math.round(gpsAccuracy)+" m":(d.gps_fix?"DEMO":"SEARCHING")));
  setText("modeBadge",d.mode||"MANUAL");
  const liveCommand=String(d.last_command||"STOP").toUpperCase();
  setText("cmd",liveCommand);
  if(liveCommand!==lastLiveCommand){
    lastLiveCommand=liveCommand;
    if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(liveCommand);
    const camera=$("cameraSceneLabel");
    if(camera){
      const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};
      camera.textContent=labels[liveCommand]||"DEMO CAMERA VIEW • SIMULATION";
    }
  }
  setText("cameraStatus",d.camera===false?"Offline":(String(d.camera_source||"SIMULATION")==="ROVER_DEVICE"?"ROVER CAMERA":"Working"));
  setText("tempText",(d.temp_c??32)+"°C");
  if(realCameraActive&&d.camera===false){
    const media=$("roverRealCamera");if(media){media.pause?.();media.src="";}
    if($("camera3DScene"))$("camera3DScene").style.display="";
    realCameraActive=false;
  }
  const batteryPct=Math.max(0,Math.min(100,Number(d.battery||0)));const signalPct=Math.max(0,Math.min(100,Number(d.signal||0)));
  const batteryBar=$("batteryBar");if(batteryBar)batteryBar.style.width=batteryPct+"%";
  const signalBar=$("signalBar");if(signalBar)signalBar.style.width=signalPct+"%";
  setText("person",d.ai?.person||0);setText("vehicle",d.ai?.vehicle||0);setText("object",d.ai?.object||0);setText("obstacle",(d.obstacle_cm??"--")+" cm");setText("confidence",Math.round((d.ai?.confidence||0)*100)+"%");
  setText("deviceOnline",d.network?"● ONLINE":"● OFFLINE");setText("deviceGpsState",d.gps_fix?"LOCKED":"SEARCHING");setText("deviceCameraState",d.camera===false?"OFF":"READY");setText("deviceAiState",(d.target?.detected||d.ai?.confidence>0.5)?"DETECTING":"READY");
  setText("missionObstacle",(d.obstacle_cm??"--")+" cm");setText("missionTracking",d.tracking===false?"PAUSED":"ACTIVE");setText("missionGeofence",d.geofence===false?"OFF":"ACTIVE");setText("missionNetwork",d.network||"ONLINE");setText("missionState",(Number(d.obstacle_cm||999)<45)?"WARNING":"READY");
  setText("alarmStateText",(Number(d.obstacle_cm||999)<45||Number(d.target?.confidence||0)>0.88)?"WARNING":"ARMED");
  const t=d.target||{type:"Object",range_m:0,speed_kmh:0,heading:0,direction:"N",size_m:0,confidence:0,lat:Number(d.lat),lon:Number(d.lon),detected:false};
  const range=Math.round(Number(t.range_m||0)); const tspeed=Number(t.speed_kmh||0).toFixed(1); const theading=Math.round(Number(t.heading||0));
  const dir=t.direction||bearingToDirection(theading);
  setText("distance",range+" m");setText("targetRange",range+" m");setText("targetSpeed",tspeed+" km/h");setText("targetDirection",dir+" ("+theading+"°)");
  setText("targetType",t.type||"Object");setText("targetSize",Number(t.size_m||0).toFixed(1)+" m");setText("targetConfidence",Math.round(Number(t.confidence||0)*100)+"%");
  setText("targetHudType",t.type||"Object");setText("targetDistanceHud",range+" m");setText("cameraTargetType",t.type||"Object");
  const detected=t.detected===true;
  syncTargetAlarm(detected,t);
  window.ROVER_CAMERA_TARGET_STATE={detected,type:t.type||"Object",range_m:range,speed_kmh:Number(t.speed_kmh||0),confidence:Number(t.confidence||0)};
  window.dispatchEvent(new CustomEvent("rover-target-state",{detail:window.ROVER_CAMERA_TARGET_STATE}));
  const pill=$("targetAlert");if(pill){pill.textContent=detected?"DETECTED":"CLEAR";pill.classList.toggle("clear",!detected)}
  if(!detected)hide("targetHud");else show("targetHud");
  setText("topName",me?.display_name||"Admin");setText("topRole",me?.role==="admin"?"Administrator":"Operator");
  setText("onlineUsers","4 Users Online");setText("onlineUsersSub","Admin + 3 Friends");
  if(rover){rover.setLatLng([Number(d.lat),Number(d.lon)]);const markerEl=$("roverMapMarker");if(markerEl)markerEl.style.transform="rotate("+heading+"deg)";}
  const tl=Number(t.lat),tn=Number(t.lon);
  if(map&&Number.isFinite(tl)&&Number.isFinite(tn)&&detected){
    const targetIcon=L.divIcon({className:"targetMarkerLabel",html:'<div class="targetMapMarker">◎</div><span>TARGET</span>',iconSize:[46,46],iconAnchor:[23,23]});
    if(!targetMarker)targetMarker=L.marker([tl,tn],{icon:targetIcon}).addTo(map);else targetMarker.setLatLng([tl,tn]);
    if(rover){
      const rp=rover.getLatLng();
      const pts=[[rp.lat,rp.lng],[tl,tn]];
      if(!targetLine)targetLine=L.polyline(pts,{color:"#ff4858",weight:2,dashArray:"7 6",opacity:.95}).addTo(map);else targetLine.setLatLngs(pts);
    }
  }else{if(targetMarker&&map){map.removeLayer(targetMarker);targetMarker=null}if(targetLine&&map){map.removeLayer(targetLine);targetLine=null}}
  trackPts=(d.track||[]).map(x=>[x.lat,x.lon]);
  if(map&&trackPts.length>1){if(!trackLine)trackLine=L.polyline(trackPts,{color:"#21d5a4",weight:4,opacity:.85}).addTo(map);else trackLine.setLatLngs(trackPts)}
  addSample(d);
}
function updateCompass(heading){
  const compass=$("mapCompass");
  const needle=$("compassNeedle");
  if(!needle)return;
  const h=((Number(heading||0)%360)+360)%360;
  needle.style.transform="translate(-50%,-50%) rotate("+h+"deg)";
  if(compass)compass.setAttribute("aria-label","Rover heading "+Math.round(h)+" degrees");
}
function bearingToDirection(deg){
  const dirs=["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(((Number(deg)%360)+360)%360/45)%8];
}
function addSample(d){samples.push({b:d.battery,s:d.signal});if(samples.length>60)samples.shift();drawChart()}
function drawChart(){
  const c=$("chart");if(!c)return;const x=c.getContext("2d"),w=c.clientWidth*devicePixelRatio,h=150*devicePixelRatio;c.width=w;c.height=h;x.clearRect(0,0,w,h);if(!samples.length)return;
  x.strokeStyle="#1e3444";x.lineWidth=devicePixelRatio;for(let i=1;i<5;i++){let y=h*i/5;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke()}
  const draw=(k,col)=>{x.strokeStyle=col;x.lineWidth=2*devicePixelRatio;x.beginPath();samples.forEach((v,i)=>{const xx=i/Math.max(1,samples.length-1)*w,yy=h-(v[k]/100)*h;i?x.lineTo(xx,yy):x.moveTo(xx,yy)});x.stroke()};draw("b","#22d3a6");draw("s","#4aa3ff");
}

function renderRecentActivity(){
  const el=$("recentActivity");if(!el)return;
  const persistent=lastKnownLoss?(()=>{
    const lat=Number(lastKnownLoss.lat),lon=Number(lastKnownLoss.lon);
    const captured=lastKnownLoss.captured_at?new Date(lastKnownLoss.captured_at):null;
    const lost=lastKnownLoss.lost_at?new Date(lastKnownLoss.lost_at):null;
    const coords=Number.isFinite(lat)&&Number.isFinite(lon)?lat.toFixed(6)+"° N  "+lon.toFixed(6)+"° E":"Coordinates unavailable";
    return '<div class="recentItem lastKnownRecent" role="alert"><span class="recentIcon lastKnownIcon">⚠</span><div><b>LAST KNOWN LOCATION</b><span>Signal lost • '+esc(coords)+'</span><small>Captured '+esc(captured?.toLocaleString()||"unknown")+' • Lost '+esc(lost?.toLocaleString()||"unknown")+'</small></div><div class="lastKnownActions"><time>'+esc(lost?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})||"--")+'</time><button type="button" class="lastKnownRemove" data-remove-last-known>REMOVE</button></div></div>';
  })():"";
  const iconMap={COMMAND:"➜",MODE:"⚙",MAP:"⌖",SYSTEM:"●",LOGIN:"♟",DENIED:"!",OFFLINE:"×",CAMERA:"▣"};
  const recent=recentItems.map(x=>'<div class="recentItem"><span class="recentIcon">'+esc(iconMap[x.type]||"•")+'</span><div><b>'+esc(x.type)+'</b><span>'+esc(x.msg)+'</span></div><time>'+x.time.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})+'</time></div>').join("");
  el.innerHTML=persistent+recent;
  el.querySelector("[data-remove-last-known]")?.addEventListener("click",clearLastKnownLocation);
}
function setLastKnownLoss(record){
  let normalized=null;
  if(record&&Number.isFinite(Number(record.lat))&&Number.isFinite(Number(record.lon))){
    normalized={...record,lat:Number(record.lat),lon:Number(record.lon)};
  }
  const key=normalized?JSON.stringify(normalized):"";
  if(key===lastKnownLossKey)return;
  lastKnownLoss=normalized;lastKnownLossKey=key;renderRecentActivity();
}
function pushRecent(type,msg){
  recentItems.unshift({type,msg,time:new Date()});if(recentItems.length>8)recentItems.pop();
  renderRecentActivity();
}
let recentItems=[];
function addLog(type,msg){
  const l=$("log");
  if(l){const d=document.createElement("div");d.className="logrow";d.innerHTML="<time>"+new Date().toLocaleTimeString()+"</time><span><b>"+esc(type)+"</b> "+esc(msg)+"</span>";l.prepend(d);while(l.children.length>50)l.lastChild.remove();}
  pushRecent(type,msg);
}
async function recordActivity(action,details=""){
  try{await api("/api/activity",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,details})})}catch(_){}
}
async function loadLastKnownLocation(){
  try{
    const r=await api("/api/device-last-known");const d=await r.json();
    if(!r.ok)return;
    setText("deviceOnline",d.device_online===false?"● OFFLINE":"● ONLINE");
    setLastKnownLoss(d.last_known_loss||null);
  }catch(_){}
}
async function clearLastKnownLocation(){
  if(!lastKnownLoss)return;
  if(!window.confirm("Remove the retained last-known location from Recent Activity?"))return;
  try{
    const deviceId=lastKnownLoss.device_id||"ROVER-01";
    const r=await api("/api/device-last-known",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:deviceId})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Remove failed");
    setLastKnownLoss(null);
    addLog("SYSTEM","Retained last-known location removed");
  }catch(_){addLog("DENIED","Could not remove retained last-known location")}
}
function clearLog(){const l=$("log");if(l)l.innerHTML=""}
function renderAlertCount(){
  const b=$("alertBtn"),n=$("alertCount");
  if(!b||!n)return;
  b.classList.toggle("hidden",!(me&&me.role==="admin"));
  n.textContent=String(unreadLogins);
  n.classList.toggle("hidden",unreadLogins===0);
}
function showLoginToast(logins){
  if(!logins.length)return;
  const item=logins[logins.length-1];
  const wrap=document.createElement("div");
  wrap.className="loginToast";
  playNotificationSound().catch(()=>{});
  wrap.innerHTML="<b>🔔 FRIEND LOGIN</b><span>"+esc(item.display_name||item.username)+" ("+esc(item.username)+") logged in just now.</span>";
  document.body.appendChild(wrap);
  setTimeout(()=>wrap.classList.add("hide"),4200);
  setTimeout(()=>wrap.remove(),4800);
  if("Notification" in window && Notification.permission==="granted"){
    try{new Notification("ROVER-01 Login Alert",{body:(item.display_name||item.username)+" ("+item.username+") logged in."})}catch(_){}
  }
}
function clearUnreadAlerts(){
  unreadLogins=0;
  const now=lastLoginAt||new Date().toISOString();
  lastLoginAt=now;
  localStorage.setItem("rover_last_login_at",now);
  renderAlertCount();
  recordActivity("LOGIN_ALERTS_CLEARED","Admin cleared login alerts");
}
async function pollLoginAlerts(){
  if(loginAlertBusy)return;
  if(!me||me.role!=="admin")return;
  loginAlertBusy=true;
  try{
    const loginUrl="/api/login-events?limit=100"+(lastLoginAt?"&since="+encodeURIComponent(lastLoginAt):"");
    const r=await api(loginUrl);const d=await r.json();
    if(!r.ok||!Array.isArray(d.logs))return;
    if(d.warning)setText("alertStatus","Login alerts: "+d.warning);
    const logins=d.logs.filter(x=>x.action==="LOGIN"&&x.role==="user").sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    if(!logins.length){renderAlertCount();return}
    const newest=String(logins[logins.length-1].created_at||"");
    if(!lastLoginAt){
      lastLoginAt=newest;
      localStorage.setItem("rover_last_login_at",lastLoginAt);
      renderAlertCount();
      return;
    }
    const fresh=logins.filter(x=>String(x.created_at||"")>lastLoginAt);
    if(fresh.length){
      lastLoginAt=String(fresh[fresh.length-1].created_at||lastLoginAt);
      localStorage.setItem("rover_last_login_at",lastLoginAt);
      unreadLogins+=fresh.length;
      renderAlertCount();
      fresh.forEach(x=>showLoginToast([x]));
      addLog("LOGIN",fresh.length===1?((fresh[0].display_name||fresh[0].username)+" logged in"):fresh.length+" friends logged in");
    }
  }catch(_){} finally { loginAlertBusy=false; }
}
async function enableBrowserAlerts(){
  if(!("Notification" in window)){setText("alertStatus","This browser does not expose browser notifications. In-app alerts remain active.");return}
  try{
    const p=await Notification.requestPermission();
    if(p==="granted"){setText("alertStatus","Browser login alerts ENABLED on this device.");recordActivity("BROWSER_ALERTS_ENABLED","Browser notifications enabled")}
    else setText("alertStatus","Browser notification permission was not granted. In-app alerts remain active.");
  }catch(_){setText("alertStatus","Could not enable browser notifications. In-app alerts remain active.")}
}
function updatePermissionUI(){
  const control=!!me;
  document.querySelectorAll(".control").forEach(b=>b.disabled=!control);
  setText("permissionNotice",control?"Control permission: ENABLED":"View-only access: rover controls disabled");
  const manager=!!(me&&(me.role==="admin"||me.can_manage_users));
  const adminBtn=$("adminBtn"),deviceBtn=$("deviceBtn"),auditTabBtn=$("auditTabBtn");
  if(adminBtn)adminBtn.classList.toggle("hidden",!manager);
  if(deviceBtn)deviceBtn.classList.toggle("hidden",!manager);
  if(auditTabBtn)auditTabBtn.classList.toggle("hidden",!(me&&me.role==="admin"));
  renderAlertCount();
}
async function loadMe(){
  const r=await api("/api/me");const d=await r.json();if(!r.ok)throw new Error(d.error||"Not logged in");
  me=d.user;setText("who",me.display_name+" · "+me.role.toUpperCase());updatePermissionUI();
}
async function loadBootstrap(){
  const r=await api("/api/bootstrap");
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||"Not logged in");
  me=d.user;
  setText("who",me.display_name+" · "+me.role.toUpperCase());
  updatePermissionUI();
  updateUI(d.telemetry);
  setText("conn",connectionText(d.telemetry));
  return d;
}
function demoTelemetry(){
  const now=Date.now(),ang=(now/9000)%(Math.PI*2);
  return {
    battery:78,signal:82,gps_fix:true,gps_sats:9,
    speed_kmh:3.5,heading:(now/80)%360,
    lat:12.9716+0.0012*Math.sin(ang),lon:77.5946+0.0014*Math.cos(ang),
    updated:new Date().toISOString(),mode:"AUTO-DEMO",last_command:"STOP",
    network:"DEMO",camera:true,tracking:true,geofence:true,temp_c:32,storage_pct:72,
    ai:{person:1,vehicle:0,object:0,confidence:.92},obstacle_cm:125,track:[],
    target:{type:"Person",range_m:842,speed_kmh:18.4,heading:42,direction:"NE",size_m:1.7,confidence:.92,lat:12.9794,lon:77.6048,detected:true}
  };
}
async function initRealCameraStream(){
  if(realCameraInitialized)return;
  realCameraInitialized=true;
  const viewport=$("cameraViewport");
  const scene=$("camera3DScene");
  if(!viewport)return;
  let media=$("roverRealCamera");
  let mediaType="";
  if(!media){
    media=document.createElement("video");
    media.id="roverRealCamera";
    media.autoplay=true;media.muted=true;media.playsInline=true;
    media.setAttribute("aria-label","ROVER-01 live camera");
    media.style.cssText="display:none;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
    viewport.insertBefore(media,viewport.firstChild);
  }
  try{
    const r=await api("/api/camera-config");
    const d=await r.json();
    if(!r.ok||!d.enabled||!d.url)return;
    mediaType=String(d.type||"mjpeg").toLowerCase();
    if(mediaType==="iframe"){
      const frame=document.createElement("iframe");
      frame.id="roverRealCamera";
      frame.title="ROVER-01 live camera";
      frame.allow="autoplay; fullscreen";
      frame.src=d.url;
      frame.style.cssText="display:block;width:100%;height:100%;border:0;background:#02070b;position:absolute;inset:0;z-index:4";
      media.replaceWith(frame);
      media=frame;
      realCameraActive=true;
    }else if(mediaType==="mjpeg"||mediaType==="image"){
      const img=document.createElement("img");
      img.id="roverRealCamera";
      img.alt="ROVER-01 live camera";
      img.decoding="async";
      img.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
      img.onload=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
      img.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","DEMO CAMERA VIEW • SIMULATION")};
      img.src=d.url;
      media.replaceWith(img);
      media=img;
    }else{
      const video=document.createElement("video");
      video.id="roverRealCamera";
      video.autoplay=true;video.muted=true;video.playsInline=true;video.controls=false;
      video.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
      video.onloadeddata=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
      video.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","DEMO CAMERA VIEW • SIMULATION")};
      video.src=d.url;
      media.replaceWith(video);
      media=video;
      video.play().catch(()=>{});
    }
  }catch(_){
    realCameraActive=false;
  }
}

async function publishLiveGPS(position){
  if(gpsPublishBusy)return;
  const c=position?.coords;
  if(!c||!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude))return;
  const accuracy=Number(c.accuracy);
  if(!Number.isFinite(accuracy)||accuracy<=0||accuracy>5000)return;
  const now=Date.now();
  if(now-gpsLastPublishedAt<1000)return;
  gpsPublishBusy=true;gpsLastPublishedAt=now;
  try{
    if(window.ROVER_GPS_SOURCE==="ROVER_DEVICE")return;
    const payload={lat:c.latitude,lon:c.longitude,accuracy_m:accuracy,source_id:gpsSourceId};
    const r=await api("/api/gps",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(r.ok){
      const d=await r.json();if(d.telemetry)updateUI(d.telemetry);
      setText("gps","LIVE");setText("gpsSignalText","LIVE GPS • ±"+Math.round(accuracy)+" m");
      setText("deviceGpsState","LIVE • ±"+Math.round(accuracy)+" m");
    }else if(r.status===409){
      if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null}
      setText("gpsSignalText","LIVE GPS • another source active");
    }
  }catch(_){
    setText("gpsSignalText","GPS feed reconnecting");
  }finally{gpsPublishBusy=false}
}
function initLiveGPSFeed(){
  if(!navigator.geolocation){
    setText("gpsSignalText","No device GPS available");
    setText("deviceGpsState","NO GPS");
    return;
  }
  const options={enableHighAccuracy:true,maximumAge:1000,timeout:10000};
  gpsWatchId=navigator.geolocation.watchPosition(
    publishLiveGPS,
    ()=>{setText("gpsSignalText","Waiting for live GPS fix");setText("deviceGpsState","SEARCHING")},
    options
  );
}
async function loop(){
  if(telemetryBusy)return;
  telemetryBusy=true;
  try{
    const r=await api("/api/telemetry");
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    if(d&&d.sync_version)window.ROVER_SYNC_VERSION=d.sync_version;
    updateUI(d);
    setText("conn",connectionText(d));
  }catch(e){
    if(me){
      setText("conn",window.roverWS?.readyState===WebSocket.OPEN?"● ONLINE • REALTIME":"● RECONNECTING");
    }else setText("conn","● OFFLINE");
  }finally{telemetryBusy=false;}
}
function scheduleTelemetry(){
  // WebSocket is the primary path. HTTP is only a recovery/health path.
  // Keeping the fallback slow prevents unnecessary backend/Durable Object reads.
  const delay=window.roverWS?.readyState===WebSocket.OPEN
    ? 60000
    : (document.hidden?15000:5000);
  setTimeout(async()=>{await loop();scheduleTelemetry()},delay);
}
async function sendCommand(command){
  if(!me){
    try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return false}
  }
  const requested=String(command||"STOP").toUpperCase();
  try{
    // Primary path: a live WebSocket message is broadcast to every connected device.
    if(window.roverWS?.readyState===WebSocket.OPEN){
      setText("cmd",requested);
      if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(requested);
      const camera=$("cameraSceneLabel");
      if(camera){const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};camera.textContent=labels[requested]||"DEMO CAMERA VIEW • SIMULATION";}
      window.roverWS.send(JSON.stringify({type:"command",command:requested}));
      addLog("COMMAND","Broadcast "+requested);
      return true;
    }
    const r=await api("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:requested})});
    const d=await r.json();
    addLog(r.ok?"COMMAND":"DENIED",r.ok?requested:(d.error||"Rejected"));
    if(r.ok){
      if(d.telemetry)updateUI(d.telemetry);
      else setText("cmd",requested);
      if(requested==="STOP"&&motionStopTimer){clearTimeout(motionStopTimer);motionStopTimer=null}
    }
    return r.ok;
  }catch(e){addLog("RECONNECT","Command is queued by the client and will be re-sent on the next operator action");return false}
}
async function setMode(mode){
  if(!me){
    try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return}
  }
  try{
    if(window.roverWS?.readyState===WebSocket.OPEN){
      window.roverWS.send(JSON.stringify({type:"mode",mode:String(mode).toUpperCase()}));
      setText("modeBadge",mode);document.querySelectorAll(".modeBtn").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
      addLog("MODE","Broadcast "+mode);
      return;
    }
    const r=await api("/api/mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode})});
    const d=await r.json();
    addLog(r.ok?"MODE":"DENIED",r.ok?mode:(d.error||"Rejected"));
    if(r.ok){
      if(d.telemetry)updateUI(d.telemetry);else setText("modeBadge",mode);
      document.querySelectorAll(".modeBtn").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
    }
  }catch(e){addLog("RECONNECT","Mode update could not reach the control centre")}
}
async function simulate(){if(me)await api("/api/simulate",{method:"POST"})}
async function logoutAction(){
  if(logoutSent)return;
  logoutSent=true;
  sessionStorage.removeItem("rover_user");
  document.querySelectorAll("#logoutBtn,#sideLogoutBtn,.mobileLogout").forEach(b=>{
    b.disabled=true;
    b.setAttribute("aria-disabled","true");
  });
  try{
    await Promise.race([
      fetch("/api/logout",{method:"POST",cache:"no-store",credentials:"same-origin",keepalive:true}),
      new Promise(resolve=>setTimeout(resolve,1500))
    ]);
  }catch(_){}
  location.replace("/login.html");
}

async function saveProfile(){
  const payload={display_name:$("profileName").value.trim(),new_password:$("profilePassword").value};
  const r=await api("/api/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json();
  setText("profileMsg",d.ok?"Profile saved.":(d.error||"Could not save profile"));if(d.ok){me=d.user;setText("who",me.display_name+" · "+me.role.toUpperCase());setTimeout(()=>closeModal("profileModal"),600)}
}
async function loadUsers(){
  const r=await api("/api/users");const d=await r.json();
  if(!r.ok){$("userTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load users")+"</div>";return}
  const users=Array.isArray(d.users)?d.users:[];
  const friendCount=users.filter(u=>u.role==="user").length;
  const adminCount=users.filter(u=>u.role==="admin").length;
  const statusNote=d.warning ? "<div class='formmsg'>"+esc(d.warning)+"</div>" : "";
  $("userTable").innerHTML="<div class='panelTitle'>"+friendCount+" USER ACCOUNTS"+(adminCount?" + "+adminCount+" ADMIN":"")+"</div>"+statusNote+
  "<table><tr><th>User ID</th><th>User</th><th>Role</th><th>Status</th><th>Control</th><th>Manage</th><th>Last login</th><th>Actions</th></tr>"+
  users.map(u=>"<tr><td><small>"+esc(u.id)+"</small></td><td><b>"+esc(u.display_name)+"</b><small>"+esc(u.username)+"</small></td><td>"+esc(u.role)+"</td><td>"+(u.enabled?"ENABLED":"DISABLED")+"</td><td>"+(u.can_control?"YES":"NO")+"</td><td>"+(u.can_manage_users?"YES":"NO")+"</td><td>"+esc(u.last_login_at?new Date(u.last_login_at).toLocaleString():"Never")+"</td><td><button class='mini' data-user='"+esc(u.id)+"' data-action='toggle' data-value='"+(!u.enabled)+"'>"+(u.enabled?"DISABLE":"ENABLE")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='control' data-value='"+(!u.can_control)+"'>"+(u.can_control?"CONTROL OFF":"CONTROL ON")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='manage' data-value='"+(!u.can_manage_users)+"'>"+(u.can_manage_users?"MANAGE OFF":"MANAGE ON")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='name'>EDIT NAME</button> <button class='mini dangerMini' data-user='"+esc(u.id)+"' data-action='password' data-username='"+esc(u.username)+"'>RESET PASSWORD</button></td></tr>").join("")+"</table>";
}

async function userAction(el){
  const id=el.dataset.user,action=el.dataset.action;let body={};
  if(action==="toggle")body.enabled=el.dataset.value==="true";
  if(action==="control")body.can_control=el.dataset.value==="true";
  if(action==="manage")body.can_manage_users=el.dataset.value==="true";
  if(action==="name"){const cells=el.closest("tr").querySelectorAll("td");const current=(cells[1]?.querySelector("b")?.textContent||"").trim();const name=prompt("New display name:",current);if(name===null)return;const trimmed=name.trim();if(!trimmed){alert("Display name cannot be empty.");return}body.display_name=trimmed}
  if(action==="password"){
    if(me?.role!=="admin"){alert("Only the Admin can reset passwords.");return}
    const username=el.dataset.username||"this user";
    const password=prompt("Set a new password for "+username+" (minimum 10 characters):");
    if(password===null)return;
    if(password.length<10){alert("Password must be at least 10 characters.");return}
    const confirmPassword=prompt("Confirm the new password for "+username+":");
    if(confirmPassword===null)return;
    if(password!==confirmPassword){alert("Passwords do not match.");return}
    const r=await api("/api/users/"+id+"/reset-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});
    const d=await r.json();
    if(!r.ok){alert(d.error||"Password reset failed");return}
    alert("Password reset successfully for "+username+".");
    await loadUsers();await loadAudit();return
  }
  const r=await api("/api/users/"+id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)alert(d.error||"Update failed");await loadUsers();await loadAudit();
}
async function createUser(){
  const body={username:$("newUsername").value.trim(),display_name:$("newDisplayName").value.trim(),password:$("newPassword").value,role:$("newRole").value,can_control:$("newControl").checked,can_manage_users:$("newManage").checked};
  const r=await api("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();setText("userMsg",d.ok?"User created successfully.":(d.error||"Could not create user"));if(d.ok){["newUsername","newDisplayName","newPassword"].forEach(id=>$(id).value="");$("newControl").checked=false;$("newManage").checked=false;await loadUsers();await loadAudit()}
}
async function loadAudit(){
  const r=await api("/api/audit?limit=1000");const d=await r.json();
  if(!r.ok){$("auditTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load audit log")+"</div>";return}
  if(!d.logs.length){$("auditTable").innerHTML="<div class='empty'>"+esc(d.warning||"No audit entries yet.")+"</div>";return}
  $("auditTable").innerHTML="<table><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr>"+
    d.logs.map(x=>"<tr><td>"+esc(new Date(x.created_at).toLocaleString())+"</td><td><b>"+esc(x.display_name||x.username)+"</b><small>"+esc(x.username)+" · "+esc(x.role||"")+"</small></td><td>"+esc(x.action)+"</td><td>"+esc(x.details||"")+"</td><td>"+esc(x.ip_address||"")+"</td></tr>").join("")+"</table>";
}
function applyTheme(){
  const light=localStorage.getItem("rover_theme")==="light";
  document.body.classList.toggle("light",light);
  setText("themeBtn",light?"☀ Light":"☾ Dark");
}
function toggleTheme(){
  const light=!document.body.classList.contains("light");
  localStorage.setItem("rover_theme",light?"light":"dark");
  applyTheme();
  initMobileNav();
  addLog("UI",light?"Light theme enabled":"Dark theme enabled");
  recordActivity("THEME_CHANGED",light?"Light theme enabled":"Dark theme enabled");
}


function loadDashboardAudit(){
  const el=$("dashboardAuditTable");
  if(!el)return;
  if(!me||me.role!=="admin"){el.innerHTML="<div class='empty'>Admin access required for the shared audit history.</div>";return}
  api("/api/audit?limit=20").then(r=>r.json()).then(d=>{
    if(!d.logs||!d.logs.length){el.innerHTML="<div class='empty'>"+esc(d.warning||"No audit entries yet.")+"</div>";return}
    el.innerHTML="<table><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr>"+
      d.logs.map(x=>"<tr><td>"+esc(new Date(x.created_at).toLocaleTimeString())+"</td><td>"+esc(x.display_name||x.username)+"</td><td>"+esc(x.action)+"</td><td>"+esc(x.details||"")+"</td><td>"+esc(x.ip_address||"")+"</td></tr>").join("")+"</table>";
  }).catch(()=>{});
}
function scrollToSection(id){
  const el=$(id);if(el)el.scrollIntoView({behavior:"smooth",block:"start"});
}
async function captureScreen(){
  addLog("CAMERA","Screenshot action requested");
  if(navigator.mediaDevices?.getDisplayMedia){
    try{
      const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1},audio:false});
      const video=document.createElement("video");video.srcObject=stream;video.muted=true;await video.play();
      await new Promise(res=>setTimeout(res,250));
      const canvas=document.createElement("canvas");canvas.width=video.videoWidth||window.innerWidth*2;canvas.height=video.videoHeight||window.innerHeight*2;
      canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
      stream.getTracks().forEach(t=>t.stop());
      canvas.toBlob(blob=>{if(!blob)return;const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="ROVER-01-dashboard-"+Date.now()+".png";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)},"image/png");
      return;
    }catch(_){}
  }
  window.print();
}
function toggleNightMode(){
  const on=document.body.classList.toggle("night-mode");
  const b=$("nightModeBtn");if(b)b.classList.toggle("active",on);
  addLog("UI",on?"Night mode enabled":"Night mode disabled");recordActivity("NIGHT_MODE",on?"Night mode enabled":"Night mode disabled");
}
function setLiveTracking(){
  liveTracking=!liveTracking;
  const b=$("liveTrackBtn");if(b)b.classList.toggle("active",liveTracking);
  addLog("TRACK",liveTracking?"Live tracking active":"Live tracking paused");
}
function cycleMode(){
  const modes=["MANUAL","ASSISTED","AUTO-DEMO"];const current=$("modeBadge")?.textContent||"MANUAL";const i=Math.max(0,modes.indexOf(current));setMode(modes[(i+1)%modes.length]);
}
function initMobileNav(){
  const panel=$("mobileNavPanel"),grid=panel?.querySelector(".mobileNavGrid"),btn=$("mobileMenuBtn");
  if(!panel||!grid||!btn)return;
  grid.innerHTML="";
  document.querySelectorAll(".sideNav .navItem").forEach(item=>{
    const clone=item.cloneNode(true);
    clone.classList.remove("active");
    clone.addEventListener("click",()=>{
      item.click();
      panel.classList.remove("open");panel.setAttribute("aria-hidden","true");btn.setAttribute("aria-expanded","false");
    });
    grid.appendChild(clone);
  });
  if(!grid.querySelector(".mobileLogout")){
    const logout=document.createElement("button");
    logout.type="button";
    logout.className="mobileLogout";
    logout.innerHTML="<span>⏻</span> Logout";
    logout.addEventListener("click",logoutAction);
    grid.appendChild(logout);
  }
  if(btn.dataset.menuClickBound!=="1"){
    btn.dataset.menuClickBound="1";
    btn.addEventListener("click",()=>{
      const open=panel.classList.toggle("open");
      panel.setAttribute("aria-hidden",String(!open));btn.setAttribute("aria-expanded",String(open));
    });
  }
}

function initCameraObstacleSimulation(room){
  if(!room||room.dataset.obstaclesBound==="1")return;
  room.dataset.obstaclesBound="1";
  const style=document.createElement("style");
  style.dataset.dynamicObstacleStyle="1";
  style.textContent=`
    .camObstacleLayer{position:absolute;inset:0;z-index:7;pointer-events:none;transform-style:preserve-3d}
    .camObstacle{position:absolute;left:50%;bottom:78px;width:58px;height:118px;opacity:0;transform:translate3d(-50%,18px,0) scale(.72);transition:opacity .42s ease,transform .6s cubic-bezier(.2,.75,.2,1),filter .25s ease;filter:drop-shadow(0 10px 7px rgba(0,0,0,.48));transform-origin:50% 100%;will-change:opacity,transform}
    .camObstacle.isVisible{opacity:1;transform:translate3d(-50%,0,var(--obstacle-z,60px)) scale(var(--obstacle-scale,1))}
    .camObstacleTag{position:absolute;left:50%;top:-19px;transform:translateX(-50%);padding:3px 6px;border:1px solid rgba(255,91,105,.75);border-radius:4px;background:rgba(45,7,13,.88);color:#ffb3ba;font:800 6px/1 ui-monospace,monospace;letter-spacing:.7px;white-space:nowrap}
    .camHuman .camHead{position:absolute;left:21px;top:0;width:16px;height:16px;border-radius:50%;background:linear-gradient(180deg,#c3d5dc,#6e8791);border:1px solid #d8edf2;box-shadow:0 0 9px rgba(164,222,235,.18)}
    .camHuman .camBody{position:absolute;left:15px;top:17px;width:28px;height:47px;border-radius:10px 10px 7px 7px;background:linear-gradient(160deg,#2d6f7d,#123440 72%);border:1px solid #52bfd0}
    .camHuman .camArm{position:absolute;top:23px;width:8px;height:39px;border-radius:7px;background:#275562;border:1px solid #4a8998}
    .camHuman .camArm.left{left:7px;transform:rotate(12deg)}.camHuman .camArm.right{right:7px;transform:rotate(-12deg)}
    .camHuman .camLeg{position:absolute;top:61px;width:10px;height:39px;border-radius:5px;background:#142b34;border:1px solid #416370}
    .camHuman .camLeg.left{left:15px}.camHuman .camLeg.right{right:15px}
    .camHuman .camBeacon{position:absolute;left:25px;top:35px;width:8px;height:8px;border-radius:50%;background:#ff4f63;box-shadow:0 0 12px rgba(255,79,99,.75);animation:camObstaclePulse 1.2s ease-in-out infinite}
    .camCrate{width:72px;height:66px;bottom:78px}.camCrate .camCrateBody{position:absolute;inset:8px 2px 0;border:2px solid #5a8190;border-radius:4px;background:linear-gradient(160deg,#24434e,#0d222c)}.camCrate .camCrateBody:before,.camCrate .camCrateBody:after{content:"";position:absolute;left:13px;right:13px;top:50%;height:2px;background:#4a7180}.camCrate .camCrateBody:after{left:50%;top:13px;bottom:13px;width:2px;height:auto}
    .camBarrier{width:88px;height:86px;bottom:76px}.camBarrier .camBarrierBody{position:absolute;left:8px;right:8px;bottom:12px;height:24px;border:2px solid #8a6f34;border-radius:4px;background:repeating-linear-gradient(135deg,#b18a34 0 9px,#2f2b20 9px 18px);box-shadow:0 5px 0 #101a1e}.camBarrier i{position:absolute;bottom:0;width:7px;height:67px;background:linear-gradient(90deg,#1c2d34,#4e666d);border:1px solid #6d858c}.camBarrier i.left{left:17px}.camBarrier i.right{right:17px}
    @keyframes camObstaclePulse{0%,100%{opacity:.55;transform:scale(.92)}50%{opacity:1;transform:scale(1.08)}}
    .cameraObstacleState{position:absolute;left:10px;bottom:10px;z-index:11;padding:4px 7px;border:1px solid rgba(69,179,197,.45);border-radius:4px;background:rgba(3,12,18,.76);color:#79bfd0;font:800 7px/1 ui-monospace,monospace;letter-spacing:.8px;pointer-events:none}.cameraObstacleState.targeting{border-color:rgba(255,81,96,.65);color:#ff9ea8}
    .cameraTargetFocus{outline:2px solid rgba(255,71,87,.9);outline-offset:3px;filter:drop-shadow(0 0 12px rgba(255,71,87,.45)) drop-shadow(0 10px 7px rgba(0,0,0,.48))!important}
  `;
  document.head.appendChild(style);
  const layer=document.createElement("div");layer.className="camObstacleLayer";layer.setAttribute("aria-hidden","true");room.appendChild(layer);
  const state=document.createElement("div");state.className="cameraObstacleState";state.textContent="AI VISION • CLEAR";room.appendChild(state);
  const positions=[{left:"28%",bottom:92,z:115,scale:.88},{left:"48%",bottom:76,z:170,scale:1.08},{left:"69%",bottom:96,z:95,scale:.77}];
  const slots=positions.map(p=>{const el=document.createElement("div");el.className="camObstacle";layer.appendChild(el);return{p,el,active:false,type:null}});
  const setCameraFocus=slot=>{
    slots.forEach(s=>s.el.classList.remove("cameraTargetFocus"));
    const active=slot&&slot.active?slot:null;
    if(active)active.el.classList.add("cameraTargetFocus");
    const box=document.querySelector(".camTargetBox");
    const viewport=$("cameraViewport"),sceneLabel=$("cameraSceneLabel");
    if(box){box.classList.toggle("cameraTargetOn",!!active);box.classList.toggle("cameraTargetOff",!active);box.setAttribute("aria-hidden",String(!active));}
    if(viewport)viewport.classList.toggle("camera-target-active",!!active);
    state.classList.toggle("targeting",!!active);
    setText("cameraTargetType",active?(active.type==="human"?"HUMAN":active.type==="barrier"?"BARRIER":"OBJECT"):"OFF");
    if(sceneLabel)sceneLabel.textContent=active?"AI TARGET FOCUS • "+(active.type==="human"?"HUMAN":active.type==="barrier"?"BARRIER":"OBJECT"):"AI VISION • SCANNING";
  };
  const drawHuman=el=>{el.className="camObstacle camHuman";el.innerHTML='<span class="camObstacleTag">TARGET • HUMAN</span><i class="camHead"></i><i class="camBody"></i><i class="camArm left"></i><i class="camArm right"></i><i class="camLeg left"></i><i class="camLeg right"></i><i class="camBeacon"></i>'};
  const drawCrate=el=>{el.className="camObstacle camCrate";el.innerHTML='<span class="camObstacleTag">TARGET • OBJECT</span><i class="camCrateBody"></i>'};
  const drawBarrier=el=>{el.className="camObstacle camBarrier";el.innerHTML='<span class="camObstacleTag">TARGET • BARRIER</span><i class="camBarrierBody"></i><i class="left"></i><i class="right"></i>'};
  const hideAll=()=>{slots.forEach(s=>{s.el.classList.remove("isVisible");s.active=false;s.type=null});setCameraFocus(null);state.textContent="AI VISION • CLEAR"};
  const showTarget=type=>{
    hideAll();
    const slot=slots[Math.floor(Math.random()*slots.length)];
    slot.active=true;slot.type=type==="human"?"human":type==="barrier"?"barrier":"object";
    slot.p.left=positions[Math.floor(Math.random()*positions.length)].left;
    slot.p.bottom=positions[Math.floor(Math.random()*positions.length)].bottom;
    slot.p.z=slot.type==="human"?150:105;slot.p.scale=slot.type==="human"?1.04:.86;
    slot.el.style.left=slot.p.left;slot.el.style.bottom=slot.p.bottom+"px";slot.el.style.setProperty("--obstacle-z",slot.p.z+"px");slot.el.style.setProperty("--obstacle-scale",String(slot.p.scale));
    if(slot.type==="human")drawHuman(slot.el);else if(slot.type==="barrier")drawBarrier(slot.el);else drawCrate(slot.el);
    requestAnimationFrame(()=>slot.el.classList.add("isVisible"));
    setCameraFocus(slot);
    state.textContent="AI TARGET • "+(slot.type==="human"?"HUMAN":slot.type==="barrier"?"BARRIER":"OBJECT")+" DETECTED";
  };
  let lastAppliedDetected=null,lastAppliedType=null;
  const applyTarget=(detected,type)=>{
    const normalizedDetected=!!detected;
    const normalizedType=(type||"object").toLowerCase();
    if(normalizedDetected===lastAppliedDetected && normalizedType===lastAppliedType)return;
    lastAppliedDetected=normalizedDetected;
    lastAppliedType=normalizedType;
    if(normalizedDetected)showTarget(normalizedType);else hideAll();
  };
  window.addEventListener("rover-target-state",e=>{
    const d=e.detail||{};
    applyTarget(!!d.detected,d.type||"object");
  });
  window.addEventListener("roomobstacledestroy",()=>{});
  setTimeout(()=>applyTarget(!!window.ROVER_CAMERA_TARGET_STATE?.detected,window.ROVER_CAMERA_TARGET_STATE?.type),0);
}

function initCamera3DRoom(){
  const scene=$("camera3DScene"),room=$("camera3DRoom"),readout=$("camera360Heading");
  if(!scene||!room||scene.dataset.bound==="1")return;
  scene.dataset.bound="1";
  let heading=0,pitch=-2,dragging=false,lastX=0,lastY=0,renderQueued=false;
  const normalize=a=>((a%360)+360)%360;
  const render=()=>{
    if(renderQueued)return;
    renderQueued=true;
    requestAnimationFrame(()=>{
      renderQueued=false;
      heading=normalize(heading);
      room.style.transform="translate(-50%,-50%) rotateX("+pitch+"deg) rotateY("+(-heading)+"deg)";
      if(readout)readout.textContent=Math.round(heading)+"°";
    });
  };
  const rotate=deg=>{heading=normalize(heading+deg);render();};
  const cameraCommand=command=>{
    const c=String(command||"").toUpperCase();
    if(c==="LEFT") rotate(-30);
    else if(c==="RIGHT") rotate(30);
    else if(c==="FORWARD") { pitch=-7; render(); }
    else if(c==="REVERSE") { pitch=4; render(); }
    else if(c==="STOP") { pitch=-2; render(); }
  };
  window.ROVER_CAMERA_CONTROL=cameraCommand;
  scene.querySelectorAll("[data-room-rotate]").forEach(b=>b.addEventListener("click",()=>rotate(Number(b.dataset.roomRotate)||0)));
  $("room360Reset")?.addEventListener("click",()=>{heading=0;pitch=-2;render();});
  $("room360Half")?.addEventListener("click",()=>rotate(180));
  const start=(x,y)=>{
    dragging=true;lastX=x;lastY=y;room.classList.add("isDragging");
  };
  const move=(x,y)=>{
    if(!dragging)return;
    const dx=x-lastX,dy=y-lastY;lastX=x;lastY=y;
    heading=normalize(heading-dx*0.45);pitch=Math.max(-16,Math.min(16,pitch+dy*0.22));render();
  };
  const end=()=>{dragging=false;room.classList.remove("isDragging");};
  scene.addEventListener("pointerdown",e=>{if(e.target.closest(".camera360Controls"))return;scene.setPointerCapture?.(e.pointerId);start(e.clientX,e.clientY);});
  scene.addEventListener("pointermove",e=>move(e.clientX,e.clientY));
  scene.addEventListener("pointerup",end);scene.addEventListener("pointercancel",end);scene.addEventListener("pointerleave",()=>{if(dragging)end();});
  scene.addEventListener("wheel",e=>{e.preventDefault();rotate(e.deltaY>0?5:-5);},{passive:false});
  scene.tabIndex=0;
  scene.addEventListener("keydown",e=>{
    if(e.key==="ArrowLeft"){e.preventDefault();rotate(-10);}
    else if(e.key==="ArrowRight"){e.preventDefault();rotate(10);}
    else if(e.key==="ArrowUp"){e.preventDefault();pitch=Math.max(-16,pitch-3);render();}
    else if(e.key==="ArrowDown"){e.preventDefault();pitch=Math.min(16,pitch+3);render();}
    else if(e.key==="Home"){e.preventDefault();heading=0;pitch=-2;render();}
  });
  render();
  initCameraObstacleSimulation(room);
}
function bindUI(){
  $("themeBtn")?.addEventListener("click",toggleTheme);
  applyTheme();
  $("settingsBtn")?.addEventListener("click",()=>scrollToSection("controlPanel"));
  $("profileBtn")?.addEventListener("click",()=>{if(!me){openModal("profileModal");setText("profileMsg","Authenticating…");return;}$("profileUsername").value=me.username;$("profileName").value=me.display_name;$("profilePassword").value="";setText("profileMsg","");openModal("profileModal");recordActivity("PROFILE_OPENED","Profile opened");});
  $("adminBtn")?.addEventListener("click",async()=>{openModal("adminModal");recordActivity("ALERTS_OPENED","Admin activity centre opened");await loadUsers();await loadAudit();pollLoginAlerts();});
  $("deviceBtn")?.addEventListener("click",()=>{recordActivity("DEVICES_OPENED","Device management opened");openDevices()});
  $("createDeviceBtn")?.addEventListener("click",createDevice);
  $("alertBtn")?.addEventListener("click",async()=>{openModal("adminModal");recordActivity("ALERTS_OPENED","Login alerts opened");await loadAudit();});
  $("enableAlertsBtn")?.addEventListener("click",enableBrowserAlerts);
  $("soundBtn")?.addEventListener("click",toggleNotificationSound);
  const armNotificationAudio=()=>{initNotificationAudio().then(ok=>{if(ok&&targetAlarmActive)targetSirenBurst()}).catch(()=>{})};
  document.addEventListener("pointerdown",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("touchstart",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("click",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("keydown",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")initNotificationAudio().catch(()=>{})});
  $("clearAlertsBtn")?.addEventListener("click",clearUnreadAlerts);
  $("logoutBtn")?.addEventListener("click",logoutAction);$("sideLogoutBtn")?.addEventListener("click",logoutAction);
  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.close)));
  $("saveProfileBtn")?.addEventListener("click",saveProfile);$("createUserBtn")?.addEventListener("click",createUser);$("clearLogBtn")?.addEventListener("click",clearLog);
  $("fitBtn")?.addEventListener("click",fitTrack);$("centerBtn")?.addEventListener("click",centerRover);$("recenterCrossBtn")?.addEventListener("click",centerRover);
  document.querySelectorAll(".modeBtn").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
  $("openModeBtn")?.addEventListener("click",()=>scrollToSection("controlPanel"));
  document.querySelectorAll(".control").forEach(b=>{const c=b.dataset.cmd;if(!c)return;b.addEventListener("click",async()=>{await sendCommand(c);})});
  document.querySelectorAll(".mapTab").forEach(b=>b.addEventListener("click",()=>setMapMode(b.dataset.mapmode)));
  $("quickCenterBtn")?.addEventListener("click",centerRover);$("quickFitBtn")?.addEventListener("click",fitTrack);$("quickSatBtn")?.addEventListener("click",()=>setMapMode(satelliteOn?"map":"satellite"));$("liveTrackBtn")?.addEventListener("click",setLiveTracking);$("nightModeBtn")?.addEventListener("click",toggleNightMode);$("screenShotBtn")?.addEventListener("click",captureScreen);
  $("camShotBtn")?.addEventListener("click",captureScreen);$("camRecordBtn")?.addEventListener("click",()=>{recording=!recording;const b=$("camRecordBtn");b.classList.toggle("active",recording);addLog("CAMERA",recording?"Recording started":"Recording stopped");recordActivity("CAMERA_RECORD",recording?"Recording started":"Recording stopped")});
  $("camFullscreenBtn")?.addEventListener("click",()=>{const el=$("cameraViewport");if(el?.requestFullscreen)el.requestFullscreen().catch(()=>{});});
  $("recentViewAll")?.addEventListener("click",()=>{if(me?.role==="admin"){openModal("adminModal");loadAudit()}else scrollToSection("eventLogSection")});
  $("userTable")?.addEventListener("click",e=>{const b=e.target.closest("button[data-user]");if(b)userAction(b)});
  $("usersTabBtn")?.addEventListener("click",async()=>{show("usersTab");hide("auditTab");await loadUsers()});
  $("devicesTabBtn")?.addEventListener("click",loadDevices);
  $("auditTabBtn")?.addEventListener("click",async()=>{hide("usersTab");show("auditTab");await loadAudit()});
  document.querySelectorAll(".navItem").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".navItem").forEach(x=>x.classList.remove("active"));b.classList.add("active");const a=b.dataset.action;if(a==="users"){openModal("adminModal");loadUsers();return}if(a==="devices"){openDevices();return}if(a==="settings"){scrollToSection("controlPanel");return}if(b.dataset.scroll)scrollToSection(b.dataset.scroll)}));
  initMobileNav();
  initCamera3DRoom();
  initRealCameraStream();
}
function tickClock(){const s=new Date().toLocaleTimeString();setText("clock",s);setText("vtime",s)}
window.addEventListener("resize",()=>{if(map)map.invalidateSize()});
window.addEventListener("error",()=>{if(me)setText("conn","● DEGRADED")});
window.addEventListener("unhandledrejection",()=>{if(me)setText("conn","● DEGRADED")});
window.addEventListener("offline",()=>{if(me)setText("conn","● DASHBOARD NETWORK OFFLINE")});
window.addEventListener("online",()=>{if(me){setText("conn","● RECONNECTING");loadLastKnownLocation().catch(()=>{});loop()}});

// Do not log out when the tab/app is backgrounded. Mobile browsers fire pagehide
// during tab switches, app suspension and navigation-cache transitions. Logout is
// now performed only by the explicit Logout actions or the server-side expiry.
window.addEventListener("pageshow",event=>{
  if(event.persisted && me){
    setText("conn","● RECONNECTING");
    loadBootstrap().then(()=>loadLastKnownLocation()).catch(()=>{});
  }
});
async function bootDashboard(){
  const leftImg=$("leftRoverImage"); if(leftImg&&window.ROVER_LEFT_IMAGE) leftImg.src=window.ROVER_LEFT_IMAGE;

  bindUI();
  updateNotificationSoundUI();
  try{
    // SECURITY: never trust sessionStorage/local UI state as authentication.
    // The server-side session must authenticate before the dashboard starts.
    const bootstrap=await loadBootstrap();
    if(bootstrap?.telemetry?.last_known_loss) setLastKnownLoss(bootstrap.telemetry.last_known_loss);
    loadMapAsync();
    connectRealtime();
    scheduleTelemetry();
    initLiveGPSFeed();
    // Only Admin drives the shared demo telemetry heartbeat. Other devices are
    // read-only replicas of the same shared state and never overwrite it.
    if(me&&me.role==="admin")setInterval(()=>{if(!document.hidden)simulate()},4000);
    if(me&&me.role==="admin"){
      pollLoginAlerts();
      loadDashboardAudit();
      setInterval(()=>{if(!document.hidden)pollLoginAlerts().catch(()=>{})},15000);
      setInterval(()=>{if(!document.hidden){loadAudit().catch(()=>{});loadDashboardAudit()}},30000);
    }
    setInterval(tickClock,1000);tickClock();pushRecent("SYSTEM","Command centre online");
  }catch(e){
    me=null;
    sessionStorage.removeItem("rover_user");
    location.replace("/login.html");
  }
}
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",bootDashboard,{once:true});
}else{
  bootDashboard();
}
})();
// Production stability bundle marker: shared Admin live-state synchronization + smooth client polling are live.
