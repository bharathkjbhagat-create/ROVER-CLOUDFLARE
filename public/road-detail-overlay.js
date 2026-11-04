(function(){
"use strict";
function attach(map,L,esc,addLog){
  const layer=L.featureGroup().addTo(map);
  map.attributionControl?.addAttribution("Road detail data © OpenStreetMap contributors");
  const cache=new Map();
  let controller=null,timer=null,lastRequestAt=0,inFlightKey="";
  try{lastRequestAt=Number(sessionStorage.getItem("defenx_road_query_at")||0)||0;}catch(_){}
  const MIN_REQUEST_INTERVAL=5*60*1000;
  const CACHE_TTL=15*60*1000;
  function style(tags){
    const highway=String(tags.highway||"road").toLowerCase();
    const styles={
      motorway:{color:"#ff6d72",weight:4.5,opacity:.95},motorway_link:{color:"#ff8588",weight:3.2,opacity:.9},
      trunk:{color:"#ff9958",weight:4.1,opacity:.95},trunk_link:{color:"#ffb06e",weight:3,opacity:.9},
      primary:{color:"#ffd166",weight:3.7,opacity:.94},primary_link:{color:"#ffdf8e",weight:2.8,opacity:.9},
      secondary:{color:"#6de0d2",weight:3.2,opacity:.92},secondary_link:{color:"#91e9df",weight:2.5,opacity:.88},
      tertiary:{color:"#a9d5ff",weight:2.8,opacity:.9},tertiary_link:{color:"#c2e1ff",weight:2.3,opacity:.86},
      unclassified:{color:"#c8edc2",weight:2.6,opacity:.9},residential:{color:"#c8edc2",weight:2.6,opacity:.9},
      living_street:{color:"#b6e4a8",weight:2.8,opacity:.92},service:{color:"#d6c7ff",weight:2.4,opacity:.9},
      track:{color:"#e7c27a",weight:2.2,opacity:.88,dashArray:"6 5"},path:{color:"#d6d9e0",weight:1.8,opacity:.82,dashArray:"3 5"},
      footway:{color:"#c5cbd3",weight:1.7,opacity:.78,dashArray:"2 5"},pedestrian:{color:"#c5cbd3",weight:1.8,opacity:.8,dashArray:"2 5"},
      cycleway:{color:"#8cc8ef",weight:1.8,opacity:.82,dashArray:"4 5"},bridleway:{color:"#c4ad8d",weight:1.7,opacity:.78,dashArray:"3 5"},
      steps:{color:"#ffbd70",weight:1.8,opacity:.8,dashArray:"2 5"}
    };
    const result=Object.assign({color:"#e5c77f",weight:2.2,opacity:.82,dashArray:"5 5"},styles[highway]||{});
    const access=String(tags.motor_vehicle||tags.vehicle||tags.access||"").toLowerCase();
    if(access==="no"||access==="private"){result.color="#ff6878";result.dashArray="3 6";}
    return result;
  }
  function render(elements){
    layer.clearLayers();
    let drawn=0;
    (Array.isArray(elements)?elements:[]).forEach(way=>{
      if(!way||way.type!=="way"||!way.tags||!way.tags.highway||!Array.isArray(way.geometry))return;
      const points=way.geometry.map(p=>[Number(p.lat),Number(p.lon)]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[0]>=-90&&p[0]<=90&&p[1]>=-180&&p[1]<=180);
      if(points.length<2)return;
      const tags=way.tags,highway=String(tags.highway).toLowerCase();
      const line=L.polyline(points,style(tags)).addTo(layer);
      const name=tags.name||tags.ref||tags["name:en"]||"Unnamed mapped way";
      const access=tags.motor_vehicle||tags.vehicle||tags.access||"Not specified";
      const surface=tags.surface||"Not mapped",width=tags.width||tags.est_width||"Not mapped",lanes=tags.lanes||"Not mapped";
      const service=tags.service?(" · "+String(tags.service).replace(/_/g," ")):"";
      const footOnly=["footway","pedestrian","steps","cycleway","bridleway"].includes(highway);
      const restricted=["no","private"].includes(String(access).toLowerCase());
      const warning=restricted?"Access tags indicate restricted/private use. Do not route through this way.":footOnly?"Mapped as a pedestrian/cycle path; not a rover vehicle road.":"Map tags do not confirm width, clearance, surface condition or physical passability.";
      const popup="<div><b>"+esc(name)+"</b><br>Class: "+esc(highway.replace(/_/g," ")+service)+"<br>Mapped width: "+esc(width)+"<br>Lanes: "+esc(lanes)+"<br>Surface: "+esc(surface)+"<br>Access: "+esc(access)+"<br><small>"+esc(warning)+"</small></div>";
      line.bindPopup(popup);
      drawn++;
    });
    return drawn;
  }
  function boxKey(){
    const center=map.getCenter(),bounds=map.getBounds();
    const halfLat=Math.min(Math.max((bounds.getNorth()-bounds.getSouth())/2,.003),.008);
    const halfLon=Math.min(Math.max((bounds.getEast()-bounds.getWest())/2,.003),.008);
    const south=Math.max(-85,center.lat-halfLat),north=Math.min(85,center.lat+halfLat);
    const west=Math.max(-180,center.lng-halfLon),east=Math.min(180,center.lng+halfLon);
    const bbox=[south.toFixed(5),west.toFixed(5),north.toFixed(5),east.toFixed(5)];
    return {center,halfLat,halfLon,bbox,key:bbox.map(v=>Number(v).toFixed(3)).join(",")};
  }
  async function load(){
    if(map.getZoom()<15){layer.clearLayers();return;}
    const area=boxKey();
    const local=cache.get(area.key);
    if(local&&Date.now()-local.at<CACHE_TTL){render(local.elements);return;}
    try{
      const saved=JSON.parse(sessionStorage.getItem("defenx_road_cache")||"null");
      if(saved&&saved.key===area.key&&Array.isArray(saved.elements)&&Date.now()-Number(saved.at)<CACHE_TTL){
        cache.set(area.key,{at:Number(saved.at),elements:saved.elements});render(saved.elements);return;
      }
    }catch(_){}
    if(inFlightKey===area.key&&controller)return;
    const wait=MIN_REQUEST_INTERVAL-(Date.now()-lastRequestAt);
    if(wait>0){
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{timer=null;load().catch(()=>{});},wait);
      return;
    }
    if(controller){try{controller.abort();}catch(_){}}
    const active=new AbortController();
    controller=active;inFlightKey=area.key;lastRequestAt=Date.now();
    try{sessionStorage.setItem("defenx_road_query_at",String(lastRequestAt));}catch(_){}
    const query='[out:json][timeout:12];way["highway"]('+area.bbox.join(",")+');out tags geom;';
    const timeout=setTimeout(()=>active.abort(),13000);
    try{
      const response=await fetch("https://overpass-api.de/api/interpreter",{
        method:"POST",headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"},
        body:"data="+encodeURIComponent(query),signal:active.signal
      });
      if(!response.ok)throw new Error("HTTP "+response.status);
      const data=await response.json();
      if(!Array.isArray(data?.elements))throw new Error("Invalid road data");
      if(active.signal.aborted)return;
      const current=map.getCenter();
      if(Math.abs(current.lat-area.center.lat)>area.halfLat*.75||Math.abs(current.lng-area.center.lng)>area.halfLon*.75)return;
      const entry={at:Date.now(),elements:data.elements};
      cache.set(area.key,entry);
      if(cache.size>12)cache.delete(cache.keys().next().value);
      render(data.elements);
      try{
        const saved=JSON.stringify({key:area.key,at:entry.at,elements:data.elements});
        if(saved.length<550000)sessionStorage.setItem("defenx_road_cache",saved);
      }catch(_){}
    }catch(err){
      if(!active.signal.aborted)addLog("MAP","Detailed road overlay unavailable; base map remains available");
    }finally{
      clearTimeout(timeout);
      if(controller===active)controller=null;
    }
  }
  function refresh(){
    if(timer)clearTimeout(timer);
    if(map.getZoom()<15){layer.clearLayers();return;}
    timer=setTimeout(()=>{timer=null;load().catch(()=>{});},900);
  }
  return {layer,refresh};
}
window.DEFENX_ROAD_DETAILS={attach};
})();