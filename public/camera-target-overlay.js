(function(){
"use strict";
function initCameraObstacleSimulation(room,$,setText){
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
window.DEFENX_CAMERA_OBSTACLES={attach:initCameraObstacleSimulation};
})();
