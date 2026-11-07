(()=>{"use strict";
let watchId=null,latest=null,marker=null,accuracyCircle=null,centered=false,following=true,mapBound=false,pendingRender=false,lastCenter=null,phoneIcon=null,renderQueued=false;
const $=id=>document.getElementById(id);
const set=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
const valid=(lat,lon)=>Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lon)&&lon>=-180&&lon<=180;
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
 set("gpsHeader","PHONE GPS LIVE");set("gpsHeaderSub","±"+Math.round(accuracy)+" m accuracy");
 set("gpsSignalText","PHONE GPS • ±"+Math.round(accuracy)+" m");
 set("mapCoords",lat.toFixed(6)+"° "+(lat>=0?"N":"S")+"  "+lon.toFixed(6)+"° "+(lon>=0?"E":"W"));
 set("mapTileStatus","PHONE GPS FIX • ±"+Math.round(accuracy)+" m");set("deviceGpsState","PHONE • ±"+Math.round(accuracy)+" m");
 scheduleRender();
}
function onError(error){
 const message=error?.code===1?"Location permission denied":error?.code===2?"Phone location unavailable":"Phone GPS timed out";
 set("gpsHeader","PHONE GPS");set("gpsHeaderSub",message);set("gpsSignalText",message.toUpperCase());set("mapTileStatus",message.toUpperCase());
}
function stop(){
 if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);
 watchId=null;latest=null;centered=false;following=true;window.DEFENX_PHONE_GPS_LATEST=null;
 const map=window.__defenxGetMap?.();
 if(map){if(marker)map.removeLayer(marker);if(accuracyCircle)map.removeLayer(accuracyCircle);}
 marker=null;accuracyCircle=null;mapBound=false;pendingRender=false;lastCenter=null;phoneIcon=null;
 set("gpsHeader","GPS");set("gpsHeaderSub","Phone GPS stopped");set("gpsSignalText","PHONE GPS STOPPED");
}
function start(){
 if(watchId!==null)return;
 set("gpsHeader","PHONE GPS");set("gpsHeaderSub","Requesting location permission…");set("gpsSignalText","WAITING FOR PHONE GPS");
 if(!navigator.geolocation){onError({code:2});return;}
 try{watchId=navigator.geolocation.watchPosition(onPosition,onError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});}
 catch(_){watchId=null;onError({code:2});}
}
window.DEFENX_PHONE_GPS_CONTROL=active=>active?start():stop();
window.DEFENX_PHONE_GPS_RENDER=render;
window.addEventListener("pagehide",stop);
})();