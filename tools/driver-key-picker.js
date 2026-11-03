// 驱动：跳过密码 → 新建 SSH → 选私钥 → 点「从本机选择」
(() => {
  const byText=(t,s="button")=>[...document.querySelectorAll(s)].find(b=>b.textContent.trim().includes(t));
  const click=(t,s="button")=>{const e=byText(t,s);if(e){e.click();return true}return false};
  const setValue=(el,v)=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}))};
  document.documentElement.dataset.theme="dark";
  let step=0,ticks=0;
  const t=setInterval(()=>{ticks++;document.documentElement.dataset.theme="dark";if(ticks>60){clearInterval(t);return}
    switch(step){
      case 0: if(click("暂不设置"))step=1; break;
      case 1: if(click("新建连接")||click("新建第一个连接")||click("＋"))step=2; break;
      case 2: { const m=document.querySelector(".modal"); if(!m)break;
        const ins=[...m.querySelectorAll("input")];
        if(ins[0])setValue(ins[0],"私钥测试"); if(ins[1])setValue(ins[1],"example.com");
        if(click("私钥"))step=3; break; }
      case 3: if(click("从本机选择"))step=4; break;
      case 4: { const m=document.querySelectorAll(".modal"); if(m.length>1)setTimeout(()=>{},0); break; }
    }} ,400);
  return "started";
})()
