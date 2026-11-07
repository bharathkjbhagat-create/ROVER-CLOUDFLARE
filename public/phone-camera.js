(()=>{
"use strict";
let stream=null,active=false,previousVideo=null;
const $=id=>document.getElementById(id);
const label=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
async function start(){
 if(active)return;
 const button=$("phoneCameraBtn");
 if(!navigator.mediaDevices?.getUserMedia){label("cameraSceneLabel","PHONE CAMERA REQUIRES HTTPS / SUPPORTED BROWSER");return;}
 if(button){button.disabled=true;button.textContent="CONNECTING…";}
 try{
  const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});
  const viewport=$("cameraViewport");
  if(!viewport)throw new Error("Camera view unavailable");
  const old=$("roverRealCamera");
  previousVideo=old||null;
  const video=document.createElement("video");
  video.id="roverRealCamera";video.autoplay=true;video.muted=true;video.playsInline=true;video.controls=false;
  video.setAttribute("aria-label","Temporary phone camera preview");
  video.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:5";
  if(old)old.replaceWith(video);else viewport.insertBefore(video,viewport.firstChild);
  video.srcObject=media;await video.play();
  stream=media;active=true;
  window.__defenxSetPhoneCameraActive?.(true);
  const scene=$("camera3DScene");if(scene)scene.style.display="none";
  label("cameraSceneLabel","TEMPORARY PHONE CAMERA • LOCAL PREVIEW");
  label("cameraStatus","PHONE CAMERA");
  if(button){button.disabled=false;button.textContent="STOP PHONE CAMERA";}
 }catch(error){
  if(stream)stream.getTracks().forEach(track=>track.stop());
  stream=null;active=false;
  if(button){button.disabled=false;button.textContent="USE PHONE CAMERA";}
  label("cameraSceneLabel",error?.name==="NotAllowedError"?"PHONE CAMERA PERMISSION DENIED":"PHONE CAMERA COULD NOT START");
 }
}
function stop(){
 if(stream)stream.getTracks().forEach(track=>track.stop());
 stream=null;active=false;
 const video=$("roverRealCamera");
 if(video?.srcObject){video.pause();video.srcObject=null;if(previousVideo&&!previousVideo.isConnected)video.replaceWith(previousVideo);else video.remove();}
 previousVideo=null;
 window.__defenxSetPhoneCameraActive?.(false);
 const scene=$("camera3DScene");if(scene)scene.style.display="";
 label("cameraSceneLabel","ROVER CAMERA • RECONNECTING");
 label("cameraStatus","Checking");
 const button=$("phoneCameraBtn");if(button){button.disabled=false;button.textContent="USE PHONE CAMERA";}
}
function bind(){
 const button=$("phoneCameraBtn");
 if(!button||button.dataset.bound==="1")return;
 button.dataset.bound="1";button.addEventListener("click",()=>active?stop():start());
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind,{once:true});else bind();
window.addEventListener("pagehide",()=>{if(stream)stream.getTracks().forEach(track=>track.stop());});
})();