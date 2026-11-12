/* DEFENX dashboard interaction refinement. Does not replace or remove existing controls. */
(function(){
  "use strict";
  function init(){
    const body=document.body;
    const menu=document.getElementById("mobileMenuBtn");
    const sidebar=document.querySelector(".sidebar");
    if(!menu||!sidebar)return;
    let backdrop=document.querySelector(".defenx-drawer-backdrop");
    if(!backdrop){backdrop=document.createElement("div");backdrop.className="defenx-drawer-backdrop";backdrop.setAttribute("aria-hidden","true");document.body.appendChild(backdrop);}
    function setOpen(open){
      body.classList.toggle("defenx-drawer-open",!!open);
      menu.setAttribute("aria-expanded",String(!!open));
      menu.setAttribute("aria-label",open?"Close navigation":"Open navigation");
      backdrop.setAttribute("aria-hidden",String(!open));
    }
    function toggleFromMenu(event){
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      setOpen(!body.classList.contains("defenx-drawer-open"));
    }
    menu.addEventListener("click",toggleFromMenu,true);
    backdrop.addEventListener("click",()=>setOpen(false));
    document.addEventListener("keydown",e=>{if(e.key==="Escape")setOpen(false);});
    sidebar.addEventListener("click",e=>{if(e.target.closest(".navItem"))setOpen(false);});
    window.addEventListener("resize",()=>{if(window.innerWidth>900)setOpen(false);},{passive:true});

    const mapHeader=document.querySelector(".mapHeader");
    const mapControls=mapHeader?.querySelector(".mapControls");
    if(mapHeader&&mapControls&&!mapHeader.querySelector(".inlineFold")){
      const fold=document.createElement("details");fold.className="inlineFold";
      const summary=document.createElement("summary");summary.textContent="MAP OPTIONS";
      fold.appendChild(summary);fold.appendChild(mapControls);mapHeader.appendChild(fold);
    }

    const returnActions=document.querySelector(".returnBaseActions");
    if(returnActions&&!returnActions.querySelector(".controlSubFold")){
      const extras=[...returnActions.querySelectorAll("#previewReturnRouteBtn,#simulateObstacleRouteBtn,#clearReturnRouteBtn")];
      if(extras.length){
        const fold=document.createElement("details");fold.className="controlSubFold";
        const summary=document.createElement("summary");summary.textContent="ADVANCED ROUTE TOOLS";
        fold.appendChild(summary);extras.forEach(el=>fold.appendChild(el));returnActions.appendChild(fold);
      }
    }

    const detectionActions=document.querySelector("#detectionEventsPanel .detectionEventsActions");
    if(detectionActions&&!detectionActions.parentElement.classList.contains("detectionSettingsFold")){
      const fold=document.createElement("details");fold.className="detectionSettingsFold";
      const summary=document.createElement("summary");summary.textContent="ALERT SETTINGS & FILTERS";
      fold.appendChild(summary);detectionActions.parentElement.insertBefore(fold,detectionActions);fold.appendChild(detectionActions);
    }

    const camera=document.querySelector("#liveCamera");
    if(camera&&!camera.querySelector(".visionToolsFold")){
      const ai=camera.querySelector("#aiVisionBar"),face=camera.querySelector("#faceScanBar");
      if(ai||face){
        const fold=document.createElement("details");fold.className="controlSubFold visionToolsFold";
        const summary=document.createElement("summary");summary.textContent="AI VISION & FACE SECURITY CONTROLS";
        fold.appendChild(summary);
        if(ai)fold.appendChild(ai);if(face)fold.appendChild(face);
        const detection=camera.querySelector("#detectionEventsPanel");
        if(detection)fold.appendChild(detection);
        camera.appendChild(fold);
      }
    }
    setOpen(false);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();