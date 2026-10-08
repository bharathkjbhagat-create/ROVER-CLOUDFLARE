self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("push",event=>{
  let data={title:"ROVER-01",body:"New control centre event",url:"/"};
  try{data=event.data?event.data.json():data}catch(_){}
  event.waitUntil(self.registration.showNotification(data.title||"ROVER-01",{body:data.body||"",data:{url:data.url||"/"},tag:"rover-login"}));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification.data&&event.notification.data.url||"/";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const c of list){if("focus" in c){c.focus();if("navigate" in c)c.navigate(url);return;}}
    if(clients.openWindow)return clients.openWindow(url);
  }));
});
