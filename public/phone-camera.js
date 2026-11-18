(()=>{
"use strict";
let facing="environment",stream=null,active=false,pending=false,originalSource=null,videoNode=null,frameTimer=null,playRetryTimer=null;
const $=id=>document.getElementById(id);
const label=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
function notice(text){
 window.DEFENX_CAMERA_NOTICE=text?{text,until:Date.now()+15000}:null;
 const ph=$("camPlaceholder"),msg=$("camPlaceholderMsg");
 if(text&&ph&&msg){msg.textContent=text;ph.hidden=false;}
}
function stopTracks(source){
 if(source&&typeof source.getTracks==="function"){
  source.getTracks().forEach(track=>{try{track.stop();}catch(_){}});
 }
}
function setButton(){
 const button=$("phoneCameraBtn");
 if(!button)return;
 button.disabled=pending;
 button.textContent=pending?"CONNECTING…":active?"STOP PHONE CAMERA":"USE PHONE CAMERA";
 button.classList.toggle("active",active);
 button.setAttribute("aria-pressed",String(active));
}
function restoreElement(){
 const current=videoNode||$("roverRealCamera");
 if(current&&current.srcObject){current.pause();current.srcObject=null;}
 if(current?.isConnected){
  if(originalSource&&!originalSource.isConnected)current.replaceWith(originalSource);
  else current.remove();
 }
 videoNode=null;
 originalSource=null;
}
async function start(){
 if(active||pending)return;
 const viewport=$("cameraViewport");
 if(!viewport){label("cameraSceneLabel","CAMERA VIEW UNAVAILABLE");return;}
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){
  label("cameraSceneLabel","OPEN DEFENX IN CHROME USING HTTPS TO ENABLE CAMERA");
  label("cameraStatus","Camera unavailable");
  return;
 }
 pending=true;setButton();
 let acquired=null,created=null,old=null;
 try{
  try{
   acquired=await navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}}
   });
  }catch(firstError){
   if(firstError?.name!=="OverconstrainedError"&&firstError?.name!=="NotFoundError")throw firstError;
   acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:true});
  }
  if(!viewport.isConnected)throw new Error("Camera view is no longer available");
  old=$("roverRealCamera");
  // Keep an incoming second-device feed visible as picture-in-picture instead of
  // detaching it when this device starts its own camera.
  if(old?.dataset?.defenxRemoteCamera==="1"){
   const remoteId=String(old.dataset.defenxPeerId||"remote").replace(/[^A-Za-z0-9_-]/g,"").slice(0,64);
   old.id="defenxRemoteCamera-"+remoteId;
   viewport.appendChild(old);
   old=null;
  }
  created=document.createElement("video");
  created.id="roverRealCamera";
  created.dataset.defenxLiveStream="1";
  created.autoplay=true;created.muted=true;created.defaultMuted=true;
  created.playsInline=true;created.setAttribute("playsinline","");
  created.setAttribute("webkit-playsinline","");
  created.controls=false;
  created.setAttribute("aria-label","Temporary phone camera preview");
  created.style.cssText="display:block!important;visibility:visible!important;opacity:1!important;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:7";
  const showLivePreview=()=>{
   if(created.readyState<2||!created.videoWidth||!created.videoHeight)return;
   if(frameTimer){clearTimeout(frameTimer);frameTimer=null;}
   if(playRetryTimer){clearTimeout(playRetryTimer);playRetryTimer=null;}
   const scene=$("camera3DScene");if(scene)scene.style.display="none";
   notice(null);const placeholder=$("camPlaceholder");if(placeholder)placeholder.hidden=true;
   const badge=document.querySelector("#liveCamera .liveBadge");
   if(badge){badge.innerHTML="<i></i> LIVE";badge.classList.remove("mvOff");}
   label("cameraSceneLabel","PHONE CAMERA • LIVE PREVIEW");
   label("cameraStatus","PHONE CAMERA LIVE");
  };
  const resumePreview=()=>{
   if(!active||!created.isConnected||!created.srcObject)return;
   if(created.paused){const p=created.play();if(p&&p.catch)p.catch(()=>{});}
  };
  created.addEventListener("loadedmetadata",resumePreview);
  created.addEventListener("loadeddata",showLivePreview);
  created.addEventListener("canplay",resumePreview);
  created.addEventListener("playing",showLivePreview);
  created.addEventListener("resize",showLivePreview);
  created.onerror=()=>{label("cameraSceneLabel","PHONE CAMERA VIDEO ERROR");label("cameraStatus","Camera stream error");};
  acquired.getVideoTracks().forEach(track=>{
   track.addEventListener("unmute",resumePreview);
   track.addEventListener("ended",()=>{
    if(active){
     stream=null;active=false;setButton();restoreElement();
     window.DEFENX_PHONE_GPS_CONTROL?.(false);
     window.dispatchEvent(new CustomEvent("defenx-camera-stream",{detail:{stream:null,active:false}}));
     label("cameraSceneLabel","PHONE CAMERA DISCONNECTED");label("cameraStatus","Camera disconnected");
    }
   });
  });
  created.srcObject=acquired;
  originalSource=old||null;videoNode=created;
  if(old)old.replaceWith(created);else viewport.insertBefore(created,viewport.firstChild);
  stream=acquired;active=true;
  const scene=$("camera3DScene");if(scene)scene.style.display="none";
  window.__defenxSetPhoneCameraActive?.(true);
  // Phone GPS follows the phone camera; the browser will request location permission if needed.
  window.DEFENX_PHONE_GPS_CONTROL?.(true);
  window.dispatchEvent(new CustomEvent("defenx-camera-stream",{detail:{stream:acquired,active:true}}));
  setButton();
  try{await created.play();}catch(playError){
   // Some mobile browsers reject the play promise even though the granted stream is attached.
   if(playError?.name!=="NotAllowedError"&&playError?.name!=="AbortError")throw playError;
  }
  if(created.readyState>=2&&created.videoWidth>0&&created.videoHeight>0){
   showLivePreview();
  }else{
   label("cameraSceneLabel","CAMERA CONNECTED • WAITING FOR VIDEO");
   label("cameraStatus","Starting camera");
   // Mobile browsers occasionally need a second play() after camera metadata arrives.
   playRetryTimer=setTimeout(resumePreview,1200);
   frameTimer=setTimeout(()=>{
    frameTimer=null;
    if(active&&created.isConnected&&!(created.readyState>=2&&created.videoWidth>0&&created.videoHeight>0)){
     label("cameraSceneLabel","CAMERA PERMISSION GRANTED • NO VIDEO FRAMES RECEIVED");
     label("cameraStatus","Camera stream not producing frames");
    }
   },8000);
   if(typeof created.requestVideoFrameCallback==="function"){
    created.requestVideoFrameCallback(()=>showLivePreview());
   }
  }
 }catch(error){
  stopTracks(acquired);
  if(created?.isConnected){
   if(old&&!old.isConnected)created.replaceWith(old);
   else created.remove();
  }
  stream=null;active=false;videoNode=null;originalSource=null;
  window.DEFENX_PHONE_GPS_CONTROL?.(false);
  window.dispatchEvent(new CustomEvent("defenx-camera-stream",{detail:{stream:null,active:false}}));
  window.__defenxSetPhoneCameraActive?.(false);
  const message=error?.name==="NotAllowedError"?"ALLOW CAMERA PERMISSION IN CHROME":
   error?.name==="NotFoundError"?"NO PHONE CAMERA FOUND":
   error?.name==="NotReadableError"?"PHONE CAMERA IS BUSY — CLOSE OTHER CAMERA APPS":
   error?.name==="SecurityError"?"OPEN DEFENX USING HTTPS":
   "PHONE CAMERA COULD NOT START — RELOAD AND TRY AGAIN";
  label("cameraSceneLabel",message);
  label("cameraStatus","Unavailable");
  notice(message);
 }finally{
  pending=false;setButton();
 }
}
function stop(){
 if(!active&&!pending)return;
 if(frameTimer){clearTimeout(frameTimer);frameTimer=null;}
 if(playRetryTimer){clearTimeout(playRetryTimer);playRetryTimer=null;}
 stopTracks(stream);stream=null;active=false;pending=false;
 restoreElement();
 window.DEFENX_PHONE_GPS_CONTROL?.(false);
 window.dispatchEvent(new CustomEvent("defenx-camera-stream",{detail:{stream:null,active:false}}));
 window.__defenxSetPhoneCameraActive?.(false);
 const scene=$("camera3DScene");if(scene)scene.style.display="";
 notice(null);
 label("cameraSceneLabel","ROVER CAMERA • RECONNECTING");
 label("cameraStatus","Checking");
 setButton();
}
function bind(){
 const button=$("phoneCameraBtn");
 if(!button||button.dataset.bound==="1")return;
 button.dataset.bound="1";
 button.addEventListener("click",()=>active?stop():start());
 if(!$("phoneCameraFlipBtn")){
  const flip=document.createElement("button");
  flip.type="button";flip.id="phoneCameraFlipBtn";flip.className=button.className;
  flip.textContent="FLIP CAMERA (REAR)";flip.title="Switch between rear and front camera";
  flip.addEventListener("click",async()=>{
   facing=facing==="environment"?"user":"environment";
   flip.textContent="FLIP CAMERA ("+(facing==="environment"?"REAR":"FRONT")+")";
   if(active||pending){stop();await new Promise(r=>setTimeout(r,250));start();}
  });
  button.insertAdjacentElement("afterend",flip);
 }
 setButton();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind,{once:true});
else bind();
window.addEventListener("pagehide",()=>{if(frameTimer)clearTimeout(frameTimer);if(playRetryTimer)clearTimeout(playRetryTimer);window.dispatchEvent(new CustomEvent("defenx-camera-stream",{detail:{stream:null,active:false}}));stopTracks(stream);stream=null;active=false;});
})();