(()=>{"use strict";
let watchId=null,latest=null,marker=null,accuracyCircle=null,centered=false,following=true,mapBound=false,pendingRender=false,lastCenter=null,phoneIcon=null,renderQueued=false,staleTimer=null;
const remoteLocations=new Map();
const isDemo=window.location.pathname==="/"||window.location.pathname==="/demo"||new URLSearchParams(window.location.search).get("demo")==="1";
const $=id=>document.getElementById(id);
const set=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
const quality=m=>m<=20?"GOOD":m<=100?"FAIR":"POOR";
const valid=(lat,lon)=>Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lon)&&lon>=-180&&lon<=180;
function publish(active){
 const ws=window.roverWS;
 if(!ws||ws.readyState!==WebSocket.OPEN){return false;}
 try{
  ws.send(JSON.stringify(active&&latest?{type:"phone_gps",active:true,lat:latest.lat,lon:latest.lon,accuracy_m:latest.accuracy}:{type:"phone_gps",active:false}));
  
  return true;
 }catch(_){return false;}
}
function removeRemote(sessionId){
 const entry=remoteLocations.get(sessionId);if(!entry)return;
 if(entry.timer)clearTimeout(entry.timer);
 const map=window.__defenxGetMap?.();if(map){if(entry.marker)map.removeLayer(entry.marker);if(entry.circle)map.removeLayer(entry.circle);}
 remoteLocations.delete(sessionId);
}
function showRemote(message){
 const sessionId=String(message.session_id||"").slice(0,64);if(!sessionId)return;
 if(message.active!==true){removeRemote(sessionId);return;}
 const lat=Number(message.lat),lon=Number(message.lon),accuracy=Math.max(0,Number(message.accuracy_m)||0);
 if(!valid(lat,lon)||accuracy>1000000)return;
 const map=window.__defenxGetMap?.(),L=window.L;if(!map||!L)return;
 let entry=remoteLocations.get(sessionId);
 if(!entry){
  const icon=L.divIcon({className:"phoneGpsMarkerWrap remotePhoneGpsMarker",html:'<div style="width:20px;height:20px;border:3px solid #fff;border-radius:50%;background:#35c98a;box-shadow:0 0 0 7px rgba(53,201,138,.2),0 0 18px #35c98a"></div>',iconSize:[20,20],iconAnchor:[10,10]});
  const remoteMarker=L.marker([lat,lon],{icon,title:"SYNCED PHONE GPS",keyboard:true,zIndexOffset:1100}).addTo(map).bindTooltip("SYNCED PHONE GPS",{permanent:true,direction:"top"});
  const circle=L.circle([lat,lon],{radius:accuracy,color:"#35c98a",weight:1.5,opacity:.8,fillColor:"#35c98a",fillOpacity:.07}).addTo(map);
  entry={marker:remoteMarker,circle,timer:0};remoteLocations.set(sessionId,entry);
 }else{
  entry.marker.setLatLng([lat,lon]);entry.circle.setLatLng([lat,lon]).setRadius(accuracy);
  if(entry.timer)clearTimeout(entry.timer);
 }
 entry.timer=setTimeout(()=>removeRemote(sessionId),45000);
}
function render(){
 if(!latest)return;
 const map=window.__defenxGetMap?.(),L=window.L;
 if(!map||!L){if(!pendingRender){pendingRender=true;window.addEventListener("rover-map-ready",()=>{pendingRender=false;render();},{once:true});}return;}
 const {lat,lon,accuracy}=latest;
 if(!phoneIcon)phoneIcon=L.divIcon({className:"phoneGpsMarkerWrap",html:'<div style="width:22px;height:22px;border:3px solid #fff;border-radius:50%;background:#168cff;box-shadow:0 0 0 7px rgba(22,140,255,.22),0 0 18px #168cff"></div>',iconSize:[22,22],iconAnchor:[11,11]});
 if(!marker)marker=L.marker([lat,lon],{icon:phoneIcon,title:"PHONE GPS LOCATION",keyboard:true,zIndexOffset:1200}).addTo(map).bindTooltip("PHONE LOCATION",{permanent:true,direction:"top"});
 else {const p=marker.getLatLng();if(Math.hypot((p.lat-lat)*111000,(p.lng-lon)*111000*Math.cos(lat*Math.PI/180))>0.8)marker.setLatLng([lat,lon]);}
 if(!accuracyCircle)accuracyCircle=L.circle([lat,lon],{radius:accuracy,color:"#168cff",weight:1.5,opacity:.8,fillColor:"#168cff",fillOpacity:.08}).addTo(map);
 else accuracyCircle.setLatLng([lat,lon]).setRadius(accuracy);
 if(!mapBound){map.on("dragstart",()=>{following=false;});mapBound=true;}
 if(!centered){map.setView([lat,lon],Math.max(map.getZoom(),17),{animate:false});centered=true;lastCenter=[lat,lon];}
 else if(following&&lastCenter){const moved=Math.hypot((lastCenter[0]-lat)*111000,(lastCenter[1]-lon)*111000*Math.cos(lat*Math.PI/180));if(moved>=4){map.panTo([lat,lon],{animate:false});lastCenter=[lat,lon];}}
}
function scheduleRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render();});}
function onPosition(position){
 const c=position?.coords;if(!c)return;
 const lat=Number(c.latitude),lon=Number(c.longitude),accuracy=Math.max(0,Number(c.accuracy)||0);
 if(!valid(lat,lon))return;
 latest={lat,lon,accuracy,timestamp:position.timestamp||Date.now()};
 window.DEFENX_PHONE_GPS_LATEST=latest;
 set("gpsHeader","PHONE GPS LIVE");set("gpsHeaderSub","±"+Math.round(accuracy)+" m accuracy • "+quality(accuracy));
 set("gpsSignalText","PHONE GPS • ±"+Math.round(accuracy)+" m • "+quality(accuracy));
 set("mapCoords",lat.toFixed(6)+"° "+(lat>=0?"N":"S")+"  "+lon.toFixed(6)+"° "+(lon>=0?"E":"W"));
 set("mapTileStatus","PHONE GPS FIX • ±"+Math.round(accuracy)+" m");set("deviceGpsState","PHONE • ±"+Math.round(accuracy)+" m");
 scheduleRender();
 const synced=publish(true);
 
}
function onError(error){
 const message=error?.code===1?"Location permission denied":error?.code===2?"Phone location unavailable":"Phone GPS timed out";
 set("gpsHeader","PHONE GPS");set("gpsHeaderSub",message);set("gpsSignalText",message.toUpperCase());set("mapTileStatus",message.toUpperCase());
 set("deviceGpsState",error?.code===1?"PERMISSION DENIED":error?.code===2?"UNAVAILABLE":"NO FIX YET");
 if(error?.code===1){
  publish(false);
  if(watchId!==null)navigator.geolocation?.clearWatch(watchId);
  watchId=null;latest=null;window.DEFENX_PHONE_GPS_LATEST=null;
  if(staleTimer){clearInterval(staleTimer);staleTimer=null;}
  const map=window.__defenxGetMap?.();if(map){if(marker)map.removeLayer(marker);if(accuracyCircle)map.removeLayer(accuracyCircle);}
  marker=null;accuracyCircle=null;centered=false;
  set("mapCoords","PHONE GPS PERMISSION DENIED");
 }
 
}
// A fix that stops arriving is reported as stale instead of silently showing an old position.
function checkStale(){
 if(!latest)return;
 const age=Date.now()-latest.timestamp;
 if(age>30000){set("gpsHeaderSub","Last fix "+Math.round(age/1000)+" s ago • waiting for update");set("mapTileStatus","PHONE GPS STALE");set("deviceGpsState","STALE");}
 else publish(true);
}
function stop(){
 publish(false);
 if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);
 if(staleTimer){clearInterval(staleTimer);staleTimer=null;}
 watchId=null;latest=null;centered=false;following=true;window.DEFENX_PHONE_GPS_LATEST=null;
 const map=window.__defenxGetMap?.();
 if(map){if(marker)map.removeLayer(marker);if(accuracyCircle)map.removeLayer(accuracyCircle);}
 marker=null;accuracyCircle=null;mapBound=false;pendingRender=false;lastCenter=null;phoneIcon=null;
 set("gpsHeader","GPS");set("gpsHeaderSub","Phone GPS stopped");set("gpsSignalText","PHONE GPS STOPPED");
 set("mapTileStatus","PHONE GPS SYNC OFF");set("deviceGpsState","OFF");set("mapCoords","PHONE GPS SYNC OFF");
}
function start(){
 if(isDemo||watchId!==null)return;
 set("gpsHeader","PHONE GPS");set("gpsHeaderSub","Requesting location permission…");set("gpsSignalText","WAITING FOR PHONE GPS");set("mapTileStatus","ACQUIRING PHONE GPS…");set("deviceGpsState","ACQUIRING");
 if(!staleTimer)staleTimer=setInterval(checkStale,10000);
 try{navigator.permissions?.query({name:"geolocation"}).then(r=>{r.onchange=()=>{if(r.state==="denied")onError({code:1});else if(watchId!==null&&!latest)set("gpsHeaderSub","Permission granted • acquiring…");};if(r.state==="denied")onError({code:1});}).catch(()=>{});}catch(_){}
 if(!navigator.geolocation){onError({code:2});return;}
 try{watchId=navigator.geolocation.watchPosition(onPosition,onError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});}
 catch(_){watchId=null;onError({code:2});}
 
}
window.DEFENX_PHONE_GPS_CONTROL=active=>active?start():stop();
window.DEFENX_PHONE_GPS_RENDER=render;
window.DEFENX_PHONE_GPS_SYNC=()=>{if(watchId!==null&&latest){publish(true);}};
window.DEFENX_PHONE_GPS_REMOTE=showRemote;
window.addEventListener("visibilitychange",()=>{if(!document.hidden&&watchId!==null&&latest){publish(true);}});
window.addEventListener("pagehide",stop);
})();

