window.ROVER_DEVICE_IMAGE="/rover-device.webp";
window.ROVER_LEFT_IMAGE="/rover-left.webp";
(function(){
"use strict";
const demoMode = window.location.pathname === "/" || window.location.pathname === "/demo" || new URLSearchParams(window.location.search).get("demo") === "1";
let me=null,map=null,rover=null,targetMarker=null,targetLine=null,trackLine=null,geofence=null,satelliteOn=false,satelliteLayer=null,streetLayer=null,hybridOverlayLayer=null,trackPts=[],samples=[],telemetryBusy=false,loginAlertBusy=false,logoutSent=false,mapReady=false,motionStopTimer=null,hybridOn=false,liveTracking=true,recording=false,cameraRecorder=null,lastLiveCommand="",lastKnownLoss=null,lastKnownLossKey="",mapModeCurrent="hybrid",followRover=localStorage.getItem("defenx_map_follow")!=="off",roverGpsValid=false,lastRoverPoint=null,mapTileErrorCount=0;
let gpsWatchId=null,gpsPublishBusy=false,gpsLastPublishedAt=0,gpsSourceId=localStorage.getItem("rover_gps_source_id")||"",realCameraInitialized=false,realCameraActive=false;
let phoneCameraActive=false;
if(!gpsSourceId){gpsSourceId="gps-"+(crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2));localStorage.setItem("rover_gps_source_id",gpsSourceId)}
let lastLoginAt=localStorage.getItem("rover_last_login_at")||"",unreadLogins=0;
let notificationSoundEnabled=localStorage.getItem("rover_notification_sound")!=="off";
let notificationAudioCtx=null,targetAlarmTimer=null,targetAlarmActive=false,targetAlarmSirenTimer=null,targetDetectionInitialized=false,targetDetectedState=false;
let warningDisplayEnabled=localStorage.getItem("rover_warning_display")!=="off",lastTargetAlarmData=null;
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
if(!warningDisplayEnabled||targetAlarmActive)return;
lastTargetAlarmData=t||lastTargetAlarmData;
targetAlarmActive=true;
const old=$("targetAlarmPopup");if(old)old.remove();
const p=document.createElement("div");p.id="targetAlarmPopup";
p.setAttribute("role","alert");p.style.cssText="position:fixed;right:18px;top:76px;z-index:99999;width:min(390px,calc(100vw - 36px));padding:16px 18px;border:2px solid #ff3f52;border-radius:12px;background:linear-gradient(145deg,rgba(74,8,16,.97),rgba(24,7,12,.97));box-shadow:0 0 0 2px rgba(255,63,82,.12),0 14px 40px rgba(0,0,0,.45),0 0 28px rgba(255,63,82,.26);color:#fff;font-family:Inter,Segoe UI,Arial,sans-serif";
const type=esc(t?.type||"Object"),range=Math.round(Number(t?.range_m||0)),speed=Number(t?.speed_kmh||0).toFixed(1),conf=Math.round(Number(t?.confidence||0)*100);
p.innerHTML="<div style='font:900 17px/1.1 Inter,Segoe UI,Arial,sans-serif;letter-spacing:.5px;color:#ff7b86'>⚠ TARGET DETECTED</div><div style='margin-top:10px;font-size:13px'><b>"+type+"</b> detected in camera view</div><div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px'><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>RANGE</small><b>"+range+" m</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>SPEED</small><b>"+speed+" km/h</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>CONF.</small><b>"+conf+"%</b></span></div><button id='silenceTargetAlarmBtn' type='button' style='margin-top:12px;width:100%;height:34px;border:1px solid #ff6674;border-radius:7px;background:#3a0f18;color:#ffd8dc;font-weight:900;cursor:pointer'>SILENCE ALARM</button>";
document.body.appendChild(p);
p.querySelector("#silenceTargetAlarmBtn")?.addEventListener("click",()=>{stopTargetAlarm();});
if(notificationSoundEnabled){targetSirenBurst();targetAlarmTimer=setInterval(()=>{if(targetAlarmActive)targetSirenBurst()},900)}
}
function syncTargetAlarm(detected,t){
const now=!!detected;
if(t)lastTargetAlarmData=t;
if(!targetDetectionInitialized){targetDetectionInitialized=true;targetDetectedState=now;if(now&&warningDisplayEnabled)startTargetAlarm(t);return;}
if(now&&!targetDetectedState){if(warningDisplayEnabled)startTargetAlarm(t);}
else if(!now&&targetDetectedState)stopTargetAlarm();
else if(now&&warningDisplayEnabled&&!targetAlarmActive)startTargetAlarm(t||lastTargetAlarmData);
targetDetectedState=now;
}
function updateWarningControlUI(d){
const button=$("warningToggleBtn");
const state=$("alarmStateText");
const active=!!warningDisplayEnabled;
if(button){
button.textContent=active?"TURN WARNING OFF":"TURN WARNING ON";
button.setAttribute("aria-pressed",String(active));
button.style.borderColor=active?"#f0b44c":"#52c6a8";
button.style.background=active?"#38280d":"#10332d";
button.style.color=active?"#ffe1a0":"#baf7e5";
}
const sensorWarning=Number(d?.obstacle_cm??999)<45||!!d?.target?.detected;
if(state)state.textContent=active?(sensorWarning?"ON • WARNING":"ON • ARMED"):"OFF • DISPLAY MUTED";
}
function setWarningDisplay(enabled){
warningDisplayEnabled=!!enabled;
try{localStorage.setItem("rover_warning_display",warningDisplayEnabled?"on":"off")}catch(_){}
if(!warningDisplayEnabled)stopTargetAlarm();
else if(targetDetectedState)startTargetAlarm(lastTargetAlarmData);
updateWarningControlUI({obstacle_cm:999,target:{detected:targetDetectedState}});
setText("conn",me?"● ONLINE • WARNING DISPLAY "+(warningDisplayEnabled?"ON":"OFF"):"● DEMO • WARNING DISPLAY "+(warningDisplayEnabled?"ON":"OFF"));
}
function toggleWarningDisplay(){setWarningDisplay(!warningDisplayEnabled);}
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
function setText(id,v){const target=id==="conn"?"connStatus":id;const e=$(target);if(e)e.textContent=v;}
function show(id){const e=$(id);if(e)e.classList.remove("hidden")}
function hide(id){const e=$(id);if(e)e.classList.add("hidden")}
function openModal(id){show(id)}
function closeModal(id){const e=$(id);if(e)e.classList.add("hidden")}
async function api(url,options={}){
if(demoMode)throw new Error("This action is unavailable in the read-only demo.");
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
function isValidMapPoint(lat,lon){
const latitude=Number(lat),longitude=Number(lon);
return Number.isFinite(latitude)&&latitude>=-90&&latitude<=90&&Number.isFinite(longitude)&&longitude>=-180&&longitude<=180;
}
function updateMapFollowButton(){
const button=$("mapFollowBtn");
if(!button)return;
button.classList.toggle("active",followRover);
button.setAttribute("aria-pressed",String(followRover));
button.textContent=followRover?"FOLLOW ON":"FOLLOW";
}
function setMapFollow(enabled,writeLog=true){
followRover=Boolean(enabled);
try{localStorage.setItem("defenx_map_follow",followRover?"on":"off")}catch(_){}
updateMapFollowButton();
if(followRover&&mapReady&&map&&roverGpsValid&&lastRoverPoint)map.panTo(lastRoverPoint,{animate:true,duration:.45});
if(writeLog)addLog("MAP",followRover?"Rover follow enabled":"Rover follow paused");
}
async function toggleMapFullscreen(){
const card=$("liveMap");
if(!card)return;
if(card.classList.contains("mapFullscreenFallback")){
card.classList.remove("mapFullscreenFallback");
syncMapFullscreenUI();
return;
}
try{
if(document.fullscreenElement===card)await document.exitFullscreen();
else if(card.requestFullscreen)await card.requestFullscreen({navigationUI:"hide"});
else card.classList.add("mapFullscreenFallback");
}catch(_){card.classList.add("mapFullscreenFallback");}
syncMapFullscreenUI();
}
function syncMapFullscreenUI(){
const card=$("liveMap");
const active=Boolean(card&&(document.fullscreenElement===card||card.classList.contains("mapFullscreenFallback")));
const button=$("mapFullscreenBtn");
if(button){button.textContent=active?"EXIT FULL SCREEN":"FULL SCREEN";button.setAttribute("aria-pressed",String(active));}
if(mapReady&&map)setTimeout(()=>map.invalidateSize(true),120);
}
function leafletCssReady(){
if(window.__DEFENX_LEAFLET_CSS)return window.__DEFENX_LEAFLET_CSS;
window.__DEFENX_LEAFLET_CSS=new Promise(resolve=>{
const sources=["https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css","https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"];
let index=0,done=false;
const finish=()=>{if(!done){done=true;clearTimeout(timer);resolve();}};
const timer=setTimeout(finish,6000);
const attempt=()=>{
if(index>=sources.length){finish();return;}
const link=document.createElement("link");
link.rel="stylesheet";link.href=sources[index++];
link.onload=finish;
link.onerror=()=>{link.remove();attempt();};
document.head.appendChild(link);
};
attempt();
});
return window.__DEFENX_LEAFLET_CSS;
}
function loadMapAsync(){
if(mapReady||map)return;
if(window.__DEFENX_LEAFLET_LOADING)return;
window.__DEFENX_LEAFLET_LOADING=true;
const cssPromise=leafletCssReady();
const start=()=>cssPromise.then(()=>{window.__DEFENX_LEAFLET_LOADING=false;initMap();});
if(window.L){start();return;}
const urls=[
"https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];
let index=0;
const loadNext=()=>{
if(window.L){start();return;}
if(index>=urls.length){
window.__DEFENX_LEAFLET_LOADING=false;
show("mapFallback");setText("mapFallback","Map library unavailable. Check the connection and reload the dashboard.");
setText("mapTileStatus","MAP LIBRARY UNAVAILABLE");
return;
}
const script=document.createElement("script");
script.src=urls[index++];script.async=true;
script.onload=()=>{if(window.L)start();else loadNext();};
script.onerror=()=>{script.remove();loadNext();};
document.head.appendChild(script);
};
loadNext();
}
function initMap(){
try{
if(mapReady||map)return;
if(typeof L==="undefined")throw new Error("Leaflet unavailable");
const mapHost=$("map");
if(!mapHost)throw new Error("Map container unavailable");
mapHost.querySelectorAll(".leaflet-container").forEach(el=>el.remove());
map=L.map("map",{
zoomControl:false,preferCanvas:true,minZoom:2,maxZoom:22,
zoomSnap:.25,zoomDelta:1,wheelPxPerZoomLevel:90,wheelDebounceTime:30,
zoomAnimation:true,markerZoomAnimation:true,inertia:true,bounceAtZoomLimits:false,
worldCopyJump:true,tap:true,touchZoom:true,doubleClickZoom:true,scrollWheelZoom:true,boxZoom:true,keyboard:true
}).setView(lastRoverPoint||demoCenter,lastRoverPoint?17:15);
L.control.zoom({position:"topleft"}).addTo(map);
streetLayer=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
minZoom:2,maxZoom:22,maxNativeZoom:19,keepBuffer:4,
updateWhenIdle:false,updateWhenZooming:false,
attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
});
satelliteLayer=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{
minZoom:2,maxZoom:22,maxNativeZoom:19,keepBuffer:4,
updateWhenIdle:false,updateWhenZooming:false,
attribution:'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community'
});
const refOpts={minZoom:2,maxZoom:22,maxNativeZoom:19,keepBuffer:4,updateWhenIdle:false,updateWhenZooming:false,
attribution:'Labels © Esri, HERE, Garmin, © OpenStreetMap contributors'};
const roadLabels=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",Object.assign({zIndex:5},refOpts));
const placeLabels=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",Object.assign({zIndex:6},refOpts));
hybridOverlayLayer=L.layerGroup([roadLabels,placeLabels]);
const watchLayer=(layer,label)=>{
layer.on("loading",()=>setText("mapTileStatus",label+" LOADING"));
layer.on("load",()=>{mapTileErrorCount=0;setText("mapTileStatus",label+" READY");});
layer.on("tileerror",()=>{mapTileErrorCount++;setText("mapTileStatus",mapTileErrorCount>2?"SOME TILES UNAVAILABLE":"RETRYING TILES");});
};
watchLayer(streetLayer,"STREET");watchLayer(satelliteLayer,"SATELLITE");watchLayer(roadLabels,"STREET LABELS");
const roverIcon=L.divIcon({className:"roverMarkerLabel",html:'<div class="roverMapMarker" id="roverMapMarker">✦</div>',iconSize:[34,34],iconAnchor:[17,17]});
rover=L.marker(lastRoverPoint||demoCenter,{icon:roverIcon,opacity:roverGpsValid?1:0,keyboard:true,title:"ROVER-01"}).addTo(map);
rover.bindTooltip("ROVER-01",{permanent:true,direction:"top",className:"roverTooltip"});
if(roverGpsValid&&lastRoverPoint)geofence=L.circle(lastRoverPoint,{radius:600,color:"#18d6a3",fill:false,weight:1,dashArray:"6 6"}).addTo(map);
mapReady=true;
setMapMode("hybrid",false);
map.on("click",handleBaseMapClick);
map.on("dragstart",()=>{if(followRover)setMapFollow(false,false);});
renderReturnBase();
hide("mapFallback");hide("mapFrame");
setText("conn","CONNECTED");setText("serverHeader","Server");
updateMapFollowButton();
if(trackPts.length>1)trackLine=L.polyline(trackPts,{color:"#21d5a4",weight:4,opacity:.9}).addTo(map);
setTimeout(()=>map&&map.invalidateSize(true),100);
setTimeout(()=>map&&map.invalidateSize(true),550);
if(window.ResizeObserver){
let queued=false;
const refit=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;if(map)map.invalidateSize({pan:false});});};
const ro=new ResizeObserver(refit);
ro.observe(mapHost);if(mapHost.parentElement)ro.observe(mapHost.parentElement);
}
window.addEventListener("orientationchange",()=>setTimeout(()=>map&&map.invalidateSize(true),250));
window.dispatchEvent(new Event("rover-map-ready"));
}catch(err){
show("mapFallback");setText("conn","DEGRADED");setText("mapTileStatus","MAP INITIALIZATION FAILED");
console.error("DEFENX map initialization failed",err);
}
}
function setMapMode(mode,writeLog=true){
if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return;}
const normalized=mode==="street"?"map":mode;
if(!["map","satellite","hybrid"].includes(normalized))return;
[streetLayer,satelliteLayer,hybridOverlayLayer].forEach(layer=>{if(layer&&map.hasLayer(layer))map.removeLayer(layer);});
hybridOn=false;satelliteOn=false;
if(normalized==="satellite"){satelliteLayer.addTo(map);satelliteOn=true;}
else if(normalized==="hybrid"){satelliteLayer.addTo(map);hybridOverlayLayer.addTo(map);hybridOn=true;satelliteOn=true;}
else streetLayer.addTo(map);
mapModeCurrent=normalized;mapTileErrorCount=0;
const names={map:"Street",satellite:"Satellite",hybrid:"Hybrid"};
setText("mapMode",names[normalized]);setText("mapTileStatus",names[normalized].toUpperCase()+" LOADING");
document.querySelectorAll(".mapTab").forEach(button=>button.classList.toggle("active",button.dataset.mapmode===normalized));
if(writeLog){recordActivity("MAP_LAYER",names[normalized]+" view");addLog("MAP",names[normalized]+" view enabled");}
updateMapFollowButton();
setTimeout(()=>map&&map.invalidateSize(true),80);
}
function toggleSatellite(){setMapMode(mapModeCurrent==="satellite"?"hybrid":"satellite");}
function centerRover(){
if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return;}
if(demoMode&&rover){map.flyTo(rover.getLatLng(),17,{animate:true,duration:.65});return;}
if(!roverGpsValid||!lastRoverPoint){setText("mapTileStatus","WAITING FOR ROVER GPS");addLog("MAP","A verified rover GPS fix is required to recenter");return;}
map.flyTo(lastRoverPoint,Math.max(map.getZoom(),17),{animate:true,duration:.65});
setMapFollow(true,false);recordActivity("MAP_CENTER","Centered map on ROVER-01");
}
function fitTrack(){
if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return;}
if(demoMode){setText("mapTileStatus","SIMULATION · NO LIVE TRACK");return;}
if(!roverGpsValid||!trackLine||trackPts.length<2){setText("mapTileStatus","ROVER TRACK NOT AVAILABLE");addLog("MAP","A verified rover GPS track is required");return;}
map.fitBounds(trackLine.getBounds(),{padding:[36,36],maxZoom:18});recordActivity("MAP_FIT","Fitted map to rover track");
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
if(message.type==="phone_gps"){window.DEFENX_PHONE_GPS_REMOTE?.(message);return;}
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
const applied=updateUI(message.telemetry);
if(applied===false)return;
setText("conn",connectionText(message.telemetry));
return;
}
if(message.type==="face_profiles_changed"){window.dispatchEvent(new CustomEvent("defenx-face-profiles-changed",{detail:{operation:message.operation}}));}
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
window.DEFENX_PHONE_GPS_SYNC?.();
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
function updateUI(input){
const rawInput=input&&typeof input==="object"?input:{};
const incomingVersion=String(rawInput.sync_version||"");
const currentVersion=String(window.ROVER_SYNC_VERSION||"");
const incomingStamp=incomingVersion.startsWith("live-")?Number(incomingVersion.slice(5,18)):NaN;
const currentStamp=currentVersion.startsWith("live-")?Number(currentVersion.slice(5,18)):NaN;
const staleVersion=incomingVersion&&currentVersion&&(
Number.isFinite(incomingStamp)&&Number.isFinite(currentStamp)
? incomingStamp<currentStamp
: incomingVersion<currentVersion
);
if(staleVersion)return false;
if(incomingVersion)window.ROVER_SYNC_VERSION=incomingVersion;
const deviceGps=!demoMode&&String(rawInput.gps_source||"")==="ROVER_DEVICE"&&rawInput.gps_fix===true&&isValidMapPoint(rawInput.lat,rawInput.lon);
const simPoint=randomDemoPoint(),simTarget=randomDemoPoint();
const displayPoint=demoMode?simPoint:(deviceGps?{lat:Number(rawInput.lat),lon:Number(rawInput.lon)}:null);
const rawTarget=rawInput.target&&typeof rawInput.target==="object"?rawInput.target:{};
const deviceTarget=String(input&&input.target_source||"")==="ROVER_DEVICE";
const safeTarget=Object.assign({},rawTarget,{
type:deviceTarget?(rawTarget.type||"Object"):"Object",
detected:deviceTarget&&rawTarget.detected===true,
range_m:deviceTarget?(rawTarget.range_m||0):0,
speed_kmh:deviceTarget?(rawTarget.speed_kmh||0):0,
confidence:deviceTarget?(rawTarget.confidence||0):0,
lat:simTarget.lat,lon:simTarget.lon
});
const validTrack=deviceGps&&Array.isArray(rawInput.track)?rawInput.track.filter(point=>point&&isValidMapPoint(point.lat,point.lon)).slice(-300):[];
const d={...rawInput,lat:displayPoint?displayPoint.lat:null,lon:displayPoint?displayPoint.lon:null,gps_fix:deviceGps,gps_sats:deviceGps?Number(rawInput.gps_sats||0):0,gps_source:deviceGps?"ROVER_DEVICE":(demoMode?"SIMULATION":"NO_FIX"),gps_accuracy_m:deviceGps?rawInput.gps_accuracy_m??null:null,track:validTrack,target:safeTarget};
window.defenxLatestTelemetry=d;window.roverTelemetry=d;
const verifiedRoverFix=d.gps_fix===true&&String(d.gps_source||"")==="ROVER_DEVICE"&&isValidMapPoint(d.lat,d.lon);
const gpsQuality=d.gps_fix?(Number(d.gps_sats||0)>=8?"Excellent":Number(d.gps_sats||0)>=5?"Good":"Fair"):"No Fix";
setText("battery",Math.round(Number(d.battery||0))+"%");setText("deviceBattery",Math.round(Number(d.battery||0))+"%");
setText("signal",Math.round(Number(d.signal||0))+"%");setText("signalDevice",Number(d.signal||0)>=70?"Strong":Number(d.signal||0)>=45?"Medium":"Weak");
setText("gps",d.gps_fix?"Good":"No Fix");setText("gpsHeader",d.gps_fix?"GPS":"GPS");setText("sats",(d.gps_sats??"--")+" sats");
const speed=Number(d.speed_kmh||0),heading=((Number(d.heading||0)%360)+360)%360;
setText("speed",speed.toFixed(1)+" km/h");setText("heading","Heading "+Math.round(heading)+"°");updateCompass(heading);
setText("lat",verifiedRoverFix?Number(d.lat).toFixed(6):"--");setText("lon",verifiedRoverFix?Number(d.lon).toFixed(6):"--");setText("updated",d.updated?new Date(d.updated).toLocaleTimeString():"--");
setText("deviceOnline",d.device_online===false?"● OFFLINE":"● ONLINE");
setLastKnownLoss(d.last_known_loss||null);
setText("mapCoords",verifiedRoverFix?Number(d.lat).toFixed(4)+"° "+(Number(d.lat)>=0?"N":"S")+"  "+Number(d.lon).toFixed(4)+"° "+(Number(d.lon)>=0?"E":"W"):(demoMode?"SIMULATION · NOT LIVE":"ROVER GPS NOT FIXED"));
const gpsSource=String(d.gps_source||"SIMULATION");
const gpsAccuracy=Number(d.gps_accuracy_m);
const hasGpsAccuracy=d.gps_accuracy_m!==null&&d.gps_accuracy_m!==undefined&&Number.isFinite(gpsAccuracy);
const liveGps=verifiedRoverFix;
window.ROVER_GPS_SOURCE=gpsSource;
setText("gps",liveGps?"LIVE":(d.gps_fix?"DEMO":"NO FIX"));
setText("gpsHeader",liveGps?"ROVER GPS LIVE":"GPS");setText("gpsHeaderSub",liveGps?(hasGpsAccuracy?"ROVER FIX · ±"+Math.round(gpsAccuracy)+" m":"ROVER FIX · ACCURACY N/A"):(demoMode?"SIMULATION · NOT LIVE":"ROVER GPS NOT FIXED"));
setText("gpsSignalText",liveGps?(hasGpsAccuracy?"ROVER GPS • ±"+Math.round(gpsAccuracy)+" m":"ROVER GPS • FIXED"):(demoMode?"SIMULATION • NOT REAL GPS":"NO VERIFIED ROVER GPS"));
setText("deviceGpsState",liveGps?(hasGpsAccuracy?"ROVER • ±"+Math.round(gpsAccuracy)+" m":"ROVER • FIXED"):(demoMode?"SIMULATED":"SEARCHING"));
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
setText("cameraStatus",window.__defenxRemoteCameraActive?"REMOTE DEVICE LIVE":(d.camera===false?"Offline":(String(d.camera_source||"SIMULATION")==="ROVER_DEVICE"?"ROVER CAMERA":"Working")));
setText("tempText",(d.temp_c??32)+"°C");
if(realCameraActive&&d.camera===false&&!phoneCameraActive&&!window.__defenxRemoteCameraActive){
const media=$("roverRealCamera");if(media){media.pause?.();media.src="";}
if($("camera3DScene"))$("camera3DScene").style.display="";
realCameraActive=false;
}
const batteryPct=Math.max(0,Math.min(100,Number(d.battery||0)));const signalPct=Math.max(0,Math.min(100,Number(d.signal||0)));
const batteryBar=$("batteryBar");if(batteryBar)batteryBar.style.width=batteryPct+"%";
const signalBar=$("signalBar");if(signalBar)signalBar.style.width=signalPct+"%";
setText("person","0");setText("vehicle","0");setText("object","0");setText("obstacle",(d.obstacle_cm??"--")+" cm");setText("confidence","0%");
setText("deviceOnline",d.network?"● ONLINE":"● OFFLINE");setText("deviceGpsState",d.gps_fix?"LOCKED":"SEARCHING");setText("deviceCameraState",window.__defenxRemoteCameraActive?"REMOTE LIVE":(d.camera===false?"OFF":"READY"));setText("deviceAiState","WAITING");
setText("missionObstacle",(d.obstacle_cm??"--")+" cm");setText("missionTracking",d.tracking===false?"PAUSED":"ACTIVE");setText("missionGeofence",d.geofence===false?"OFF":"ACTIVE");setText("missionNetwork",d.network||"ONLINE");setText("missionState",(Number(d.obstacle_cm||999)<45)?"WARNING":"READY");
updateWarningControlUI(d);
const t=d.target||{type:"Object",range_m:0,speed_kmh:0,heading:0,direction:"N",size_m:0,confidence:0,lat:Number(d.lat),lon:Number(d.lon),detected:false};
const range=Math.round(Number(t.range_m||0)); const tspeed=Number(t.speed_kmh||0).toFixed(1); const theading=Math.round(Number(t.heading||0));
const dir=t.direction||bearingToDirection(theading);
setText("distance",range+" m");setText("targetRange",range+" m");setText("targetSpeed",tspeed+" km/h");setText("targetDirection",dir+" ("+theading+"°)");
setText("targetType",t.type||"Object");setText("targetSize",Number(t.size_m||0).toFixed(1)+" m");setText("targetConfidence",Math.round(Number(t.confidence||0)*100)+"%");
setText("targetHudType",t.type||"Object");setText("targetDistanceHud",range+" m");setText("cameraTargetType",t.type||"Object");
const detected=t.detected===true;
syncTargetAlarm(detected,t);
updateWarningControlUI({obstacle_cm:d.obstacle_cm,target:{detected}});
window.ROVER_CAMERA_TARGET_STATE={detected,type:t.type||"Object",range_m:range,speed_kmh:Number(t.speed_kmh||0),confidence:Number(t.confidence||0)};
window.dispatchEvent(new CustomEvent("rover-target-state",{detail:window.ROVER_CAMERA_TARGET_STATE}));
const pill=$("targetAlert");if(pill){pill.textContent=detected?"DETECTED":"CLEAR";pill.classList.toggle("clear",!detected)}
if(!detected)hide("targetHud");else show("targetHud");
setText("topName",me?.display_name||"Admin");setText("topRole",me?.role==="admin"?"Administrator":"Operator");
setText("onlineUsers","Presence unavailable");setText("onlineUsersSub","Live user count not reported");
if(rover){
if(liveGps&&isValidMapPoint(d.lat,d.lon)){
lastRoverPoint=[Number(d.lat),Number(d.lon)];roverGpsValid=true;
rover.setLatLng(lastRoverPoint);rover.setOpacity(1);
const markerEl=$("roverMapMarker");if(markerEl)markerEl.style.transform="rotate("+heading+"deg)";
if(geofence)geofence.setLatLng(lastRoverPoint);
else if(mapReady)geofence=L.circle(lastRoverPoint,{radius:600,color:"#18d6a3",fill:false,weight:1,dashArray:"6 6"}).addTo(map);
if(map&&followRover&&liveTracking){const center=map.getCenter();const moved=Math.hypot((center.lat-lastRoverPoint[0])*111000,(center.lng-lastRoverPoint[1])*111000*Math.cos(lastRoverPoint[0]*Math.PI/180));if(moved>=4)map.panTo(lastRoverPoint,{animate:false});}
}else if(demoMode&&isValidMapPoint(d.lat,d.lon)){
rover.setLatLng([Number(d.lat),Number(d.lon)]);rover.setOpacity(.72);
const markerEl=$("roverMapMarker");if(markerEl)markerEl.style.transform="rotate("+heading+"deg)";
}else{
roverGpsValid=false;lastRoverPoint=null;rover.setOpacity(0);
if(geofence&&map){map.removeLayer(geofence);geofence=null;}
}
}
if(targetMarker&&map){map.removeLayer(targetMarker);targetMarker=null;}
if(targetLine&&map){map.removeLayer(targetLine);targetLine=null;}
if(liveGps&&lastRoverPoint){
const incoming=(d.track||[]).map(point=>[Number(point.lat),Number(point.lon)]).filter(point=>isValidMapPoint(point[0],point[1])).slice(-300);
if(incoming.length)trackPts=incoming;
const previous=trackPts[trackPts.length-1];
if(!previous||Math.abs(previous[0]-lastRoverPoint[0])>0.000001||Math.abs(previous[1]-lastRoverPoint[1])>0.000001)trackPts.push(lastRoverPoint.slice());
if(trackPts.length>300)trackPts=trackPts.slice(-300);
}else if(!demoMode){trackPts=[];}
if(map&&trackPts.length>1){
if(!trackLine)trackLine=L.polyline(trackPts,{color:"#21d5a4",weight:4,opacity:.9}).addTo(map);
else trackLine.setLatLngs(trackPts);
}else if(trackLine&&map){map.removeLayer(trackLine);trackLine=null;}
addSample(d);
if(phoneCameraActive)window.DEFENX_PHONE_GPS_RENDER?.();
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
let chartRenderQueued=false;
function scheduleDrawChart(){
if(chartRenderQueued)return;
chartRenderQueued=true;
requestAnimationFrame(()=>{chartRenderQueued=false;drawChart()});
}
function addSample(d){samples.push({b:d.battery,s:d.signal});if(samples.length>60)samples.shift();scheduleDrawChart()}
function drawChart(){
const c=$("chart");if(!c)return;const w=Math.max(1,Math.round(c.clientWidth*devicePixelRatio)),h=Math.max(1,Math.round(150*devicePixelRatio));
if(c.width!==w)c.width=w;if(c.height!==h)c.height=h;
const x=c.getContext("2d");if(!x)return;x.clearRect(0,0,w,h);if(!samples.length)return;
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
wrap.innerHTML="<b>🔔 ACCOUNT LOGIN</b><span>"+esc(item.display_name||item.username)+" ("+esc(item.username)+") logged in just now.</span>";
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
const logins=d.logs.filter(x=>x.action==="LOGIN").sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
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
addLog("LOGIN",fresh.length===1?((fresh[0].display_name||fresh[0].username)+" logged in"):fresh.length+" accounts logged in");
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
const control=!!me&&!demoMode;
document.querySelectorAll(".control").forEach(b=>b.disabled=!control);
document.querySelectorAll(".modeBtn").forEach(b=>b.disabled=!control);
setText("permissionNotice",demoMode?"DEMO MODE: SIMULATED DATA ONLY • ROVER CONTROLS DISABLED":(control?"Control permission: ENABLED":"View-only access: rover controls disabled"));
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
const point=randomDemoPoint(),targetPoint=randomDemoPoint();
return {
battery:78,signal:82,gps_fix:false,gps_sats:0,gps_source:"SIMULATION",
speed_kmh:3.5,heading:Math.random()*360,
lat:point.lat,lon:point.lon,
updated:new Date().toISOString(),mode:"AUTO-DEMO",last_command:"STOP",
network:"DEMO • SIMULATED",camera:true,camera_source:"SIMULATION",target_source:"SIMULATION",
tracking:true,geofence:true,temp_c:32,storage_pct:72,
ai:{person:1,vehicle:0,object:0,confidence:.92},obstacle_cm:125,track:[],
target:{type:"Person",range_m:842,speed_kmh:18.4,heading:Math.random()*360,direction:"SIM",size_m:1.7,confidence:.92,lat:targetPoint.lat,lon:targetPoint.lon,detected:true}
};
}
async function initRealCameraStream(){
if(realCameraInitialized)return;
realCameraInitialized=true;
if(demoMode){
setText("cameraSceneLabel","DEMO CAMERA VIEW • SIMULATION ONLY");
return;
}
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
if(phoneCameraActive||window.__defenxRemoteCameraActive)return;
if(!r.ok||!d.enabled||!d.url){
realCameraActive=false;
if(scene)scene.style.display="none";
const placeholder=$("camPlaceholder"),message=$("camPlaceholderMsg");
if(message)message.textContent="NO CAMERA FEED • CONNECT ROVER CAMERA OR TAP USE PHONE CAMERA";
if(placeholder){
placeholder.hidden=false;
}
setText("cameraSceneLabel","NO LIVE CAMERA FEED");
setText("cameraStatus","No camera connected");
return;
}
const placeholder=$("camPlaceholder");if(placeholder)placeholder.hidden=true;
mediaType=String(d.type||"mjpeg").toLowerCase();
if(mediaType==="iframe"){
const frame=document.createElement("iframe");
frame.id="roverRealCamera";
frame.dataset.defenxLiveStream="1";
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
img.dataset.defenxLiveStream="1";
img.alt="ROVER-01 live camera";
img.decoding="async";
img.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
img.onload=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
img.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","CAMERA STREAM ERROR • SIMULATION VIEW")};
img.src=d.url;
media.replaceWith(img);
media=img;
}else{
const video=document.createElement("video");
video.id="roverRealCamera";
video.dataset.defenxLiveStream="1";
video.autoplay=true;video.muted=true;video.playsInline=true;video.controls=false;
video.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
video.onloadeddata=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
video.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","CAMERA STREAM ERROR • SIMULATION VIEW")};
video.src=d.url;
media.replaceWith(video);
media=video;
video.play().catch(()=>{});
}
}catch(_){
realCameraActive=false;
}
}
window.__defenxGetMap=()=>map;
window.__defenxSetPhoneCameraActive=(active)=>{
phoneCameraActive=!!active;
realCameraActive=!!active;
window.DEFENX_PHONE_GPS_CONTROL?.(!!active);
if(!active){realCameraInitialized=false;initRealCameraStream();}
};
function initLiveGPSFeed(){setText("gpsSignalText","WAITING FOR CAMERA GPS");setText("deviceGpsState","NOT ACTIVE");}
function randomDemoPoint(){return {lat:12.9716+(Math.random()-0.5)*0.018,lon:77.5946+(Math.random()-0.5)*0.022};}
async function loop(){
if(telemetryBusy)return;
telemetryBusy=true;
try{
if(demoMode){
updateUI(demoTelemetry());
setText("conn","● DEMO • SIMULATED DATA");
return;
}
const r=await api("/api/telemetry");
const d=await r.json();
if(!r.ok)throw new Error(d.error);
const applied=updateUI(d);
if(applied===false)return;
setText("conn",connectionText(d));setText("serverHeaderSub","Backend reachable");
}catch(e){
if(me){
setText("conn",window.roverWS?.readyState===WebSocket.OPEN?"● ONLINE • REALTIME":"● RECONNECTING");
}else setText("conn","● OFFLINE");setText("serverHeaderSub","Backend unavailable");
}finally{telemetryBusy=false;}
}
function scheduleTelemetry(){
const delay=window.roverWS?.readyState===WebSocket.OPEN
? (document.hidden?60000:60000)
: (document.hidden?8000:5000);
setTimeout(async()=>{await loop();scheduleTelemetry()},delay);
}
let returnBaseMarker=null,returnBaseSelection=false,returnBase=null;
let returnRouteLine=null,returnRouteMode="none",lastRoadRouteCache=null,lastRoadRouteRequestAt=0;
try{const saved=localStorage.getItem("defenx_return_base");if(saved){const parsed=JSON.parse(saved);if(parsed&&Number.isFinite(parsed.lat)&&Number.isFinite(parsed.lon)&&parsed.lat>=-90&&parsed.lat<=90&&parsed.lon>=-180&&parsed.lon<=180)returnBase=parsed;else localStorage.removeItem("defenx_return_base");}}catch(_){}
function renderReturnBase(){
if(!mapReady||!map)return;
if(returnBaseMarker){map.removeLayer(returnBaseMarker);returnBaseMarker=null;}
if(returnBase){const icon=L.divIcon({className:"returnBaseLabel",html:'<div class="returnBaseMarker">⌂</div><span>BASE</span>',iconSize:[42,42],iconAnchor:[21,21]});returnBaseMarker=L.marker([returnBase.lat,returnBase.lon],{icon,keyboard:true,title:"DEFENX Base"}).addTo(map).bindTooltip("RETURN BASE",{permanent:true,direction:"top",className:"returnBaseTooltip"});}
const label=returnBase?("BASE SET · "+returnBase.lat.toFixed(5)+", "+returnBase.lon.toFixed(5)):"BASE NOT SET";
setText("returnBaseStatus",label);
if(returnRouteLine){map.removeLayer(returnRouteLine);returnRouteLine=null;returnRouteMode="none";}
}
async function previewReturnRoute(simulateObstacle=false){
if(!mapReady||!map){addLog("ROUTE","Interactive map is still loading");return;}
if(!returnBase){setText("returnBaseStatus","BASE REQUIRED · SELECT BASE ON MAP");addLog("ROUTE","Select a base before previewing a route");return;}
const origin=roverGpsValid&&lastRoverPoint?L.latLng(lastRoverPoint[0],lastRoverPoint[1]):(demoMode?(rover?.getLatLng?.()||L.latLng(demoCenter[0],demoCenter[1])):null);
if(!origin){setText("returnBaseStatus","VERIFIED ROVER GPS REQUIRED");addLog("ROUTE","A verified rover GPS fix is required for a road route");return;}
if(returnRouteLine){map.removeLayer(returnRouteLine);returnRouteLine=null;}
const start=[origin.lat,origin.lng],destination=[returnBase.lat,returnBase.lon];
if(simulateObstacle){
const midLat=(start[0]+destination[0])/2,midLon=(start[1]+destination[1])/2;
const dLat=destination[0]-start[0],dLon=destination[1]-start[1],length=Math.max(Math.hypot(dLat,dLon),0.00001);
const offset=Math.min(0.003,Math.max(0.00035,length*0.18));
const detour=[start,[midLat-dLon/length*offset,midLon+dLat/length*offset],destination];
returnRouteLine=L.polyline(detour,{color:"#f5b942",weight:5,opacity:.9,dashArray:"9 8"}).addTo(map);
returnRouteMode="alternate";
map.fitBounds(returnRouteLine.getBounds(),{padding:[36,36],maxZoom:16});
setText("returnBaseStatus",demoMode?"DEMO DETOUR · VISUAL ONLY · NO ROVER COMMAND":"SIMULATED DETOUR · NOT A ROAD ROUTE");
addLog("ROUTE","Visual detour simulation rendered; no rover command sent");
return;
}
const routeKey=[start[0].toFixed(5),start[1].toFixed(5),destination[0].toFixed(5),destination[1].toFixed(5)].join(",");
let route=lastRoadRouteCache&&lastRoadRouteCache.key===routeKey&&Date.now()-lastRoadRouteCache.savedAt<300000?lastRoadRouteCache.route:null;
if(!route){
const now=Date.now();
if(now-lastRoadRouteRequestAt<1100){
setText("returnBaseStatus","PLEASE WAIT BEFORE REQUESTING ANOTHER ROUTE");
return;
}
lastRoadRouteRequestAt=now;
const url="https://router.project-osrm.org/route/v1/driving/"+encodeURIComponent(start[1]+","+start[0])+";"+encodeURIComponent(destination[1]+","+destination[0])+"?overview=full&geometries=geojson&steps=false&alternatives=false";
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),12000);
try{
const response=await fetch(url,{method:"GET",headers:{"Accept":"application/json"},signal:controller.signal,cache:"no-store"});
if(!response.ok)throw new Error("Routing service returned HTTP "+response.status);
const payload=await response.json();
if(payload.code!=="Ok"||!Array.isArray(payload.routes)||!payload.routes.length)throw new Error(payload.message||"No road route is available");
route=payload.routes[0];
if(!route.geometry||!Array.isArray(route.geometry.coordinates)||route.geometry.coordinates.length<2)throw new Error("The route service returned no usable road geometry");
lastRoadRouteCache={key:routeKey,route,savedAt:Date.now()};
}catch(error){
setText("returnBaseStatus",error&&error.name==="AbortError"?"ROAD ROUTE TIMED OUT":"ROAD ROUTE UNAVAILABLE");
addLog("ROUTE","Road route preview failed; no rover command was sent");
return;
}finally{
clearTimeout(timeout);
}
}
const points=route.geometry.coordinates.map(pair=>[Number(pair[1]),Number(pair[0])]).filter(pair=>isValidMapPoint(pair[0],pair[1]));
if(points.length<2){setText("returnBaseStatus","ROAD ROUTE DATA INVALID");addLog("ROUTE","Invalid road-route geometry was rejected");return;}
returnRouteLine=L.polyline(points,{color:"#22d3a6",weight:5,opacity:.96,lineJoin:"round"}).addTo(map);
returnRouteMode="road";
map.fitBounds(returnRouteLine.getBounds(),{padding:[36,36],maxZoom:18});
const km=(Number(route.distance)/1000).toFixed(2),minutes=Math.max(1,Math.round(Number(route.duration)/60));
setText("returnBaseStatus",(demoMode?"DEMO ROAD ROUTE · ":"ROAD ROUTE · ")+km+" KM · "+minutes+" MIN · PREVIEW ONLY");
addLog("ROUTE","OpenStreetMap-based road route preview rendered; no rover command sent");
}
function clearReturnRoutePreview(){
if(returnRouteLine&&map){map.removeLayer(returnRouteLine);returnRouteLine=null;}
returnRouteMode="none";
if(demoMode)setText("returnBaseStatus","DEMO PREVIEW CLEARED · "+(returnBase?"BASE SAVED":"BASE NOT SET"));
else if(returnBase) setText("returnBaseStatus","BASE SET · "+returnBase.lat.toFixed(5)+", "+returnBase.lon.toFixed(5));
else setText("returnBaseStatus","BASE NOT SET");
addLog("ROUTE","Simulation preview cleared");
}
function beginBaseSelection(){
if(!mapReady||!map){setText("returnBaseStatus","MAP STILL LOADING · TRY AGAIN");addLog("BASE","Wait for the live map to load");return;}
returnBaseSelection=true;
setText("returnBaseStatus",demoMode?"DEMO · SELECT A BASE LOCATION ON THE MAP":"SELECT A BASE LOCATION ON THE MAP");
addLog("BASE",demoMode?"Tap the map to save a simulated base; no rover movement is enabled":"Tap the map to save the return base");
}
function handleBaseMapClick(e){
if(!returnBaseSelection||!e?.latlng)return;
const lat=Number(e.latlng.lat),lon=Number(e.latlng.lng);
if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lon)||lon < -180||lon > 180){setText("returnBaseStatus","INVALID BASE LOCATION · TRY AGAIN");addLog("BASE","Rejected invalid base coordinates");return;}
returnBase={lat,lon,saved_at:new Date().toISOString()};
try{localStorage.setItem("defenx_return_base",JSON.stringify(returnBase));}catch(_){}
returnBaseSelection=false;renderReturnBase();
if(!demoMode&&window.DEFENX_FLEET&&window.DEFENX_FLEET.active()){window.DEFENX_FLEET.saveBase(lat,lon);addLog("BASE","Saving base on the server for the rover");}
if(demoMode)setText("returnBaseStatus","DEMO BASE SET · ROUTE PREVIEW ONLY");
addLog("BASE",demoMode?"Simulated base saved in this browser; no rover movement is enabled":"Base location saved on this browser");
}
async function requestReturnToBase(){
if(!demoMode&&window.DEFENX_FLEET&&window.DEFENX_FLEET.active()){
if(!confirm("Start autonomous return to base? Keep clear; be ready to press EMERGENCY STOP.")){setText("returnBaseStatus","RETURN CANCELLED");return;}
const res=await window.DEFENX_FLEET.returnToBase();
setText("returnBaseStatus",res.ok?"RETURN REQUESTED · WAITING FOR ROVER ACKNOWLEDGEMENT":"RETURN BLOCKED · "+String(res.message).toUpperCase());
addLog(res.ok?"RETURN":"RETURN BLOCKED",res.ok?"Return-to-base request sent to the rover; no arrival is claimed until the rover confirms it":res.message);
return;
}
if(demoMode){setText("returnBaseStatus","DEMO MODE · ROVER MOVEMENT DISABLED");addLog("DEMO","Return-to-base movement is disabled in the read-only demo; preview controls remain available");return;}
if(!me){try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return;}}
if(!returnBase){addLog("RETURN","Set the base first using SELECT BASE ON MAP");setText("returnBaseStatus","BASE REQUIRED · SELECT BASE ON MAP");return;}
const telemetry=window.defenxLatestTelemetry||window.roverTelemetry||null;
if(!telemetry||telemetry.gps_fix!==true||!Number.isFinite(telemetry.lat)||telemetry.lat < -90||telemetry.lat > 90||!Number.isFinite(telemetry.lon)||telemetry.lon < -180||telemetry.lon > 180){
addLog("RETURN BLOCKED","Verified, valid live rover GPS coordinates are required before return can start");setText("returnBaseStatus","RETURN BLOCKED · VERIFIED LIVE GPS REQUIRED");return;
}
if(telemetry.autonomous_navigation!==true||telemetry.obstacle_avoidance!==true||telemetry.obstacle_sensor_healthy!==true||telemetry.safety_controller_healthy!==true){
addLog("RETURN BLOCKED","Autonomous navigation, obstacle-sensor health, and safety-controller health are not all confirmed; rover was not commanded to move");setText("returnBaseStatus","RETURN BLOCKED · SAFETY CAPABILITIES UNVERIFIED");
alert("Return to Base is not started. The connected controller must confirm autonomous navigation, obstacle avoidance, healthy obstacle sensing, and a healthy safety controller. No movement command was sent.");return;
}
addLog("RETURN BLOCKED","A verified hardware return-to-base command endpoint is not yet configured; no movement command was sent");
setText("returnBaseStatus","RETURN BLOCKED · HARDWARE COMMAND ENDPOINT REQUIRED");
}
async function sendCommand(command){
if(demoMode){addLog("DEMO","Rover commands are disabled in the read-only demo");return false;}
if(!me){try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return false;}}
const requested=String(command||"STOP").toUpperCase(),telemetry=window.defenxLatestTelemetry||window.roverTelemetry||null;
if(requested!=="STOP"&&telemetry?.device_online===false){addLog("DENIED","Rover is offline; movement command was not sent");setText("permissionNotice","ROVER OFFLINE • MOVEMENT COMMAND NOT SENT");return false;}
const fleet=window.DEFENX_FLEET;
if(fleet&&fleet.active()&&["FORWARD","REVERSE","LEFT","RIGHT","STOP"].includes(requested)){
const res=await fleet.command(requested);
if(!res.ok){addLog("DENIED","Safety gate: "+res.message);setText("permissionNotice","COMMAND REFUSED · "+String(res.message).toUpperCase());return false;}
setText("cmd",requested);addLog("COMMAND",requested+" queued for rover; waiting for device acknowledgement");
if(requested==="STOP"&&motionStopTimer){clearTimeout(motionStopTimer);motionStopTimer=null;}
return true;
}
try{
const r=await api("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:requested})}),d=await r.json();
if(!r.ok||d.ok!==true){addLog("DENIED",d.error||"Control centre rejected the command");return false;}
if(d.telemetry)updateUI(d.telemetry);else setText("cmd",requested);
if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(requested);
addLog("COMMAND","Control centre accepted "+requested);
if(requested==="STOP"&&motionStopTimer){clearTimeout(motionStopTimer);motionStopTimer=null;}
return true;
}catch(_){addLog("RECONNECT","Command was not sent; check the connection and retry");return false;}
}
async function setMode(mode){
if(demoMode){addLog("DEMO","Operating modes are disabled in the read-only demo");return false;}
if(!me){try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return false;}}
try{
const r=await api("/api/mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode})}),d=await r.json();
if(!r.ok||d.ok!==true){addLog("DENIED",d.error||"Control centre rejected the mode");return false;}
if(d.telemetry)updateUI(d.telemetry);else setText("modeBadge",mode);
document.querySelectorAll(".modeBtn").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
addLog("MODE","Control centre accepted "+mode);return true;
}catch(_){addLog("RECONNECT","Mode change was not sent; check the connection and retry");return false;}
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
const adminLogs=(Array.isArray(d.logs)?d.logs:[]).filter(x=>String(x.role||"").toLowerCase()==="admin");
if(!adminLogs.length){$("auditTable").innerHTML="<div class='empty'>"+esc(d.warning||"No administrator events yet.")+"</div>";return}
const sessions=new Map(),other=[];
adminLogs.forEach(x=>{
if(x.action!=="LOGIN"&&x.action!=="LOGOUT"){other.push(x);return}
const key=x.session_id||("legacy:"+x.username+":"+x.created_at);
if(!sessions.has(key))sessions.set(key,{login:null,logout:null});
const row=sessions.get(key);
if(x.action==="LOGIN")row.login=x;else row.logout=x;
});
const sessionRows=Array.from(sessions.values()).sort((a,b)=>String(b.login?.created_at||b.logout?.created_at||"").localeCompare(String(a.login?.created_at||a.logout?.created_at||"")));
const fmt=x=>x?new Date(x).toLocaleString():"—";
$("auditTable").innerHTML="<div class='auditRetentionNote'>Successful logins and logouts are retained for 7 days, then automatically deleted.</div><table><tr><th>User</th><th>Role</th><th>Login date &amp; time</th><th>Logout date &amp; time</th><th>IP address</th><th>Device / browser</th></tr>"+
sessionRows.map(s=>{const x=s.login||s.logout;return "<tr><td><b>Admin</b></td><td>Admin</td><td>"+esc(fmt(s.login?.created_at))+"</td><td>"+esc(fmt(s.logout?.created_at))+"</td><td>"+esc((s.login||s.logout).ip_address||"")+"</td><td>"+esc((s.login||s.logout).user_agent||"")+"</td></tr>"}).join("")+
"</table>"+(other.length?"<div class='auditRetentionNote'>Other recent activity</div><table><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr>"+other.map(x=>"<tr><td>"+esc(fmt(x.created_at))+"</td><td>Admin</td><td>"+esc(x.action)+"</td><td>"+esc(x.details||"")+"</td></tr>").join("")+"</table>":"");
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
const el=$("dashboardAuditTable");if(!el)return;
if(!me||me.role!=="admin"){el.innerHTML="<div class='empty'>Admin.</div>";return}
api("/api/login-events?limit=100").then(r=>r.json()).then(d=>{
const logs=(Array.isArray(d.logs)?d.logs:[]).filter(x=>String(x.role||"").toLowerCase()==="admin");
if(!logs.length){el.innerHTML="<div class='empty'>No recent admin events.</div>";return}
const m=new Map();logs.forEach(x=>{const k=x.session_id||x.id||x.created_at+":"+x.action,s=m.get(k)||{};s[x.action==="LOGIN"?"login":"logout"]=x;m.set(k,s)});
const fmt=x=>x?new Date(x).toLocaleString():"—";
el.innerHTML="<table><tr><th>User</th><th>Login</th><th>Logout</th><th>Details</th><th>IP / device</th></tr>"+[...m.values()].map(s=>{const x=s.login||s.logout,d=[s.login&&("Login: "+(s.login.details||"OK")),s.logout&&("Logout: "+(s.logout.details||"Done"))].filter(Boolean).join(" • ");return "<tr><td><b>Admin</b></td><td>"+esc(fmt(s.login?.created_at))+"</td><td>"+esc(fmt(s.logout?.created_at))+"</td><td>"+esc(d||"—")+"</td><td>"+esc(x.ip_address||"—")+"<small>"+esc(x.user_agent||"")+"</small></td></tr>"}).join("")+"</table>";
}).catch(()=>{el.innerHTML="<div class='empty'>Load failed.</div>"});
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
function toggleCameraRecording(){
const button=$("camRecordBtn");
if(recording){recording=false;button?.classList.remove("active");button?.setAttribute("aria-pressed","false");if(button)button.title="Start camera recording";cameraRecorder?.stop();return;}
const video=$("roverRealCamera");
if(!window.MediaRecorder||video?.tagName!=="VIDEO"||!video.captureStream||video.readyState<2||!video.videoWidth){
setText("cameraSceneLabel","RECORDING UNAVAILABLE • LIVE VIDEO STREAM REQUIRED");addLog("CAMERA","Recording not started; a live recordable video stream is not connected");return;
}
try{
const stream=video.captureStream(),chunks=[],types=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"],mime=types.find(type=>MediaRecorder.isTypeSupported?.(type));
const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);cameraRecorder=recorder;
recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
recorder.onstop=()=>{
recording=false;button?.classList.remove("active");button?.setAttribute("aria-pressed","false");if(button)button.title="Start camera recording";
const blob=new Blob(chunks,{type:recorder.mimeType||"video/webm"});stream.getTracks().forEach(track=>track.stop());cameraRecorder=null;
if(blob.size){const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="defenx-camera-"+Date.now()+".webm";document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);setText("cameraSceneLabel","CAMERA RECORDING SAVED");}
else setText("cameraSceneLabel","RECORDING EMPTY • NO VIDEO DATA");
addLog("CAMERA",blob.size?"Live camera recording saved":"No video data was received");recordActivity("CAMERA_RECORD","Recording stopped");
};
recorder.onerror=()=>{recording=false;button?.classList.remove("active");button?.setAttribute("aria-pressed","false");if(button)button.title="Start camera recording";setText("cameraSceneLabel","CAMERA RECORDING FAILED");addLog("CAMERA","Browser recorder reported an error");};
recorder.start(1000);recording=true;button?.classList.add("active");button?.setAttribute("aria-pressed","true");
if(button)button.title="Stop camera recording";setText("cameraSceneLabel","LIVE CAMERA • RECORDING");addLog("CAMERA","Live camera recording started");recordActivity("CAMERA_RECORD","Recording started");
}catch(_){cameraRecorder=null;recording=false;setText("cameraSceneLabel","RECORDING UNAVAILABLE • CHECK CAMERA STREAM");addLog("CAMERA","Recording could not start for this camera stream");}
}
function toggleNightMode(){
const on=document.body.classList.toggle("night-mode");
const b=$("nightModeBtn");if(b)b.classList.toggle("active",on);
addLog("UI",on?"Night mode enabled":"Night mode disabled");recordActivity("NIGHT_MODE",on?"Night mode enabled":"Night mode disabled");
}
function openQuickSettings(){
const panel=document.querySelector(".foldCard");
if(panel){panel.open=true;panel.scrollIntoView({behavior:"smooth",block:"center"});}
const button=$("settingsBtn");if(button)button.setAttribute("aria-pressed","true");
addLog("UI","Quick settings opened");
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
$("settingsBtn")?.addEventListener("click",openQuickSettings);
$("profileBtn")?.addEventListener("click",()=>{if(!me){openModal("profileModal");setText("profileMsg","Authenticating…");return;}$("profileUsername").value=me.username;$("profileName").value=me.display_name;$("profilePassword").value="";setText("profileMsg","");openModal("profileModal");recordActivity("PROFILE_OPENED","Profile opened");});
$("adminBtn")?.addEventListener("click",async()=>{openModal("adminModal");recordActivity("ALERTS_OPENED","Admin activity centre opened");await loadUsers();await loadAudit();pollLoginAlerts();});
$("deviceBtn")?.addEventListener("click",()=>{recordActivity("DEVICES_OPENED","Device management opened");openDevices()});
$("createDeviceBtn")?.addEventListener("click",createDevice);
$("alertBtn")?.addEventListener("click",async()=>{openModal("adminModal");hide("usersTab");show("auditTab");recordActivity("ALERTS_OPENED","Login alerts opened");await loadAudit();pollLoginAlerts();});
$("enableAlertsBtn")?.addEventListener("click",enableBrowserAlerts);
$("soundBtn")?.addEventListener("click",toggleNotificationSound);
$("warningToggleBtn")?.addEventListener("click",toggleWarningDisplay);
$("warningOnBtn")?.addEventListener("click",()=>setWarningDisplay(true));
$("warningOffBtn")?.addEventListener("click",()=>setWarningDisplay(false));
updateWarningControlUI({obstacle_cm:999,target:{detected:false}});
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
$("mapFollowBtn")?.addEventListener("click",()=>setMapFollow(!followRover));
$("mapFullscreenBtn")?.addEventListener("click",toggleMapFullscreen);
document.addEventListener("fullscreenchange",syncMapFullscreenUI);
$("quickFitBtn")?.addEventListener("click",fitTrack);$("quickSatBtn")?.addEventListener("click",()=>setMapMode(satelliteOn?"map":"satellite"));$("liveTrackBtn")?.addEventListener("click",setLiveTracking);$("nightModeBtn")?.addEventListener("click",toggleNightMode);
$("camShotBtn")?.addEventListener("click",captureScreen);$("camRecordBtn")?.addEventListener("click",toggleCameraRecording);
$("camFullscreenBtn")?.addEventListener("click",async()=>{
const el=$("cameraViewport");if(!el)return;
try{
if(document.fullscreenElement){await document.exitFullscreen();}
else if(el.requestFullscreen){await el.requestFullscreen();}
else{el.classList.toggle("camera-fullscreen");}
}catch(_){el.classList.toggle("camera-fullscreen");}
});
$("recentViewAll")?.addEventListener("click",()=>{if(me?.role==="admin"){openModal("adminModal");hide("usersTab");show("auditTab");loadAudit()}else scrollToSection("eventLogSection")});
$("userTable")?.addEventListener("click",e=>{const b=e.target.closest("button[data-user]");if(b)userAction(b)});
$("usersTabBtn")?.addEventListener("click",async()=>{show("usersTab");hide("auditTab");await loadUsers()});
$("devicesTabBtn")?.addEventListener("click",async()=>{closeModal("adminModal");await openDevices()});
$("auditTabBtn")?.addEventListener("click",async()=>{hide("usersTab");show("auditTab");await loadAudit()});
document.querySelectorAll(".navItem").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".navItem").forEach(x=>x.classList.remove("active"));b.classList.add("active");const a=b.dataset.action;if(a==="users"){openModal("adminModal");loadUsers();return}if(a==="devices"){openDevices();return}if(a==="settings"){openQuickSettings();return}if(b.dataset.scroll)scrollToSection(b.dataset.scroll)}));
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
if(demoMode){
me=null;
updatePermissionUI();
setText("who","DEMO VIEW · READ ONLY");
$("missionState").textContent="DEMO PREVIEW";
$("mapHeaderTitle").textContent="MAP PREVIEW";
$("cameraHeaderTitle").textContent="CAMERA PREVIEW";
setText("serverHeaderSub","DEMO • NO SERVER CONNECTION");
setText("cameraSyncStatus","SIMULATED CAMERA • NO DEVICE SYNC");
setText("cameraSceneLabel","SIMULATED SCENE • NO LIVE VIDEO");
setText("conn","● DEMO • SIMULATED DATA");
updateUI(demoTelemetry());
setText("cameraStatus","SIMULATED PREVIEW");
loadMapAsync();
scheduleTelemetry();
setInterval(tickClock,1000);
tickClock();
return;
}
try{
await loadBootstrap();
await loadLastKnownLocation();
loadMapAsync();
connectRealtime();
scheduleTelemetry();
initLiveGPSFeed();
if(me&&me.role==="admin")setInterval(()=>{if(!document.hidden)simulate()},4000);
if(me&&me.role==="admin"){
pollLoginAlerts();
loadDashboardAudit();
setInterval(pollLoginAlerts,6000);
setInterval(()=>{loadAudit().catch(()=>{});loadDashboardAudit()},15000);
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
document.addEventListener("click",function(e){if(e.target.closest("#selectReturnBaseBtn"))beginBaseSelection();if(e.target.closest("#returnToBaseBtn"))requestReturnToBase();if(e.target.closest("#previewReturnRouteBtn"))previewReturnRoute(false);if(e.target.closest("#simulateObstacleRouteBtn"))previewReturnRoute(true);if(e.target.closest("#clearReturnRouteBtn"))clearReturnRoutePreview();});
})();

