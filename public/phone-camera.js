(()=>{
"use strict";
let stream=null,active=false,pending=false,originalSource=null,videoNode=null;
const $=id=>document.getElementById(id);
const label=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
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
    video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}}
   });
  }catch(firstError){
   if(firstError?.name!=="OverconstrainedError"&&firstError?.name!=="NotFoundError")throw firstError;
   acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:true});
  }
  if(!viewport.isConnected)throw new Error("Camera view is no longer available");
  old=$("roverRealCamera");
  created=document.createElement("video");
  created.id="roverRealCamera";
  created.dataset.defenxLiveStream="1";
  created.autoplay=true;created.muted=true;created.defaultMuted=true;
  created.playsInline=true;created.setAttribute("playsinline","");
  created.setAttribute("webkit-playsinline","");
  created.controls=false;
  created.setAttribute("aria-label","Temporary phone camera preview");
  created.style.cssText="display:block!important;visibility:visible!important;opacity:1!important;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:7";
  const showLivePreview=()=>{if(created.readyState<2||!created.videoWidth||!created.videoHeight)return;const scene=$("camera3DScene");if(scene)scene.style.display="none";const placeholder=$("camPlaceholder");if(placeholder)placeholder.hidden=true;const badge=document.querySelector("#liveCamera .liveBadge");if(badge){badge.innerHTML="<i></i> LIVE";badge.classList.remove("mvOff");}label("cameraSceneLabel","PHONE CAMERA • LIVE PREVIEW");label("cameraStatus","PHONE CAMERA LIVE");};
  created.onloadedmetadata=showLivePreview;
  created.onloadeddata=showLivePreview;
  created.onplaying=showLivePreview;
  created.onerror=()=>{label("cameraSceneLabel","PHONE CAMERA VIDEO ERROR");};
  created.srcObject=acquired;
  originalSource=old||null;videoNode=created;
  if(old)old.replaceWith(created);else viewport.insertBefore(created,viewport.firstChild);
  stream=acquired;active=true;
  const scene=$("camera3DScene");if(scene)scene.style.display="none";
  window.__defenxSetPhoneCameraActive?.(true);
  setButton();
  try{await created.play();}catch(playError){
   // Some mobile browsers reject the play promise even though the granted stream is attached.
   if(playError?.name!=="NotAllowedError"&&playError?.name!=="AbortError")throw playError;
  }
  if(created.readyState>=2){
   label("cameraSceneLabel","PHONE CAMERA • LIVE PREVIEW");
   label("cameraStatus","PHONE CAMERA LIVE");
  }else{
   label("cameraSceneLabel","CAMERA CONNECTED • WAITING FOR VIDEO");
   label("cameraStatus","Starting camera");
  }
 }catch(error){
  stopTracks(acquired);
  if(created?.isConnected){
   if(old&&!old.isConnected)created.replaceWith(old);
   else created.remove();
  }
  stream=null;active=false;videoNode=null;originalSource=null;
  window.__defenxSetPhoneCameraActive?.(false);
  const message=error?.name==="NotAllowedError"?"ALLOW CAMERA PERMISSION IN CHROME":
   error?.name==="NotFoundError"?"NO PHONE CAMERA FOUND":
   error?.name==="NotReadableError"?"PHONE CAMERA IS BUSY — CLOSE OTHER CAMERA APPS":
   error?.name==="SecurityError"?"OPEN DEFENX USING HTTPS":
   "PHONE CAMERA COULD NOT START — RELOAD AND TRY AGAIN";
  label("cameraSceneLabel",message);
  label("cameraStatus","Unavailable");
 }finally{
  pending=false;setButton();
 }
}
function stop(){
 if(!active&&!pending)return;
 stopTracks(stream);stream=null;active=false;pending=false;
 restoreElement();
 window.__defenxSetPhoneCameraActive?.(false);
 const scene=$("camera3DScene");if(scene)scene.style.display="";
 label("cameraSceneLabel","ROVER CAMERA • RECONNECTING");
 label("cameraStatus","Checking");
 setButton();
}
function bind(){
 const button=$("phoneCameraBtn");
 if(!button||button.dataset.bound==="1")return;
 button.dataset.bound="1";
 button.addEventListener("click",()=>active?stop():start());
 setButton();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind,{once:true});
else bind();
window.addEventListener("pagehide",()=>{stopTracks(stream);stream=null;active=false;});
})();