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
 if(!navigator.mediaDevices?.getUserMedia){
  label("cameraSceneLabel","PHONE CAMERA REQUIRES HTTPS / SUPPORTED BROWSER");
  return;
 }
 pending=true;setButton();
 let acquired=null,created=null,old=null;
 try{
  acquired=await navigator.mediaDevices.getUserMedia({
   video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},
   audio:false
  });
  if(!viewport.isConnected)throw new Error("Camera view is no longer available");
  old=$("roverRealCamera");
  created=document.createElement("video");
  created.id="roverRealCamera";
  created.autoplay=true;created.muted=true;created.playsInline=true;created.controls=false;
  created.setAttribute("aria-label","Temporary phone camera preview");
  created.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:5";
  created.srcObject=acquired;
  originalSource=old||null;
  videoNode=created;
  if(old)old.replaceWith(created);
  else viewport.insertBefore(created,viewport.firstChild);
  stream=acquired;active=true;
  window.__defenxSetPhoneCameraActive?.(true);
  await created.play();
  const scene=$("camera3DScene");if(scene)scene.style.display="none";
  label("cameraSceneLabel","TEMPORARY PHONE CAMERA • LOCAL PREVIEW");
  label("cameraStatus","PHONE CAMERA");
  setButton();
 }catch(error){
  stopTracks(acquired);
  if(created?.isConnected){
   if(old&&!old.isConnected)created.replaceWith(old);
   else created.remove();
  }
  stream=null;active=false;videoNode=null;originalSource=null;
  window.__defenxSetPhoneCameraActive?.(false);
  const message=error?.name==="NotAllowedError"?"PHONE CAMERA PERMISSION DENIED":
   error?.name==="NotFoundError"?"NO PHONE CAMERA FOUND":
   error?.name==="NotReadableError"?"PHONE CAMERA IS BUSY":"PHONE CAMERA COULD NOT START";
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