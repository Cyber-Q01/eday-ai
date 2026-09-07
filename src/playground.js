// Built-in chat playground (self-contained, no external assets) for quick testing.
export function playgroundHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDAY AI — Test Playground</title>
<style>
  *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:#0b1220;color:#e2e8f0;display:flex;flex-direction:column;height:100vh}
  header{padding:12px 20px;background:#111a2e;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:10px}
  header h1{font-size:15px;margin:0;font-weight:600} header span{font-size:11px;color:#7dd3fc;background:#0c4a6e33;border:1px solid #155e75;padding:2px 8px;border-radius:99px}
  .badge-yellow{color:#fde68a;background:#713f1233;border-color:#92400e}
  main{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:10px;max-width:820px;width:100%;margin:0 auto}
  .msg{max-width:78%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .u{align-self:flex-end;background:#1d4ed8;border-bottom-right-radius:4px}
  .a{align-self:flex-start;background:#1e293b;border-bottom-left-radius:4px}
  .sys{align-self:center;font-size:11px;color:#94a3b8;background:#1e293b66;border-radius:99px;padding:3px 10px}
  .chiprow{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .chip{background:#27334d;border:1px solid #334155;color:#cbd5e1;border-radius:99px;padding:5px 11px;font-size:12px;cursor:pointer}
  .chip:hover{background:#334155}
  footer{display:flex;gap:8px;padding:12px 20px;background:#111a2e;border-top:1px solid #1e293b;max-width:860px;width:100%;margin:0 auto}
  input{flex:1;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;padding:11px 14px;font-size:14px;outline:none}
  input:focus{border-color:#3b82f6}
  button{background:#2563eb;border:0;color:#fff;border-radius:10px;padding:11px 18px;font-size:14px;cursor:pointer}
  button:hover{background:#1d4ed8}
  .examples{margin:2px auto 0;max-width:860px;padding:0 20px 8px}
  .examples span{font-size:11px;color:#64748b}
  .examples button{all:unset;cursor:pointer;font-size:11px;color:#93c5fd;margin-left:10px;text-decoration:underline}
</style></head><body>
<header>
  <h1>🤖 EDAY AI Orchestration — Playground</h1>
  <span id="mode">connecting…</span>
</header>
<div class="examples"><span>Try:</span><button data-ex="buy 500 naira mtn airtime for 08031234567">Airtime</button>
<button data-ex="pay 5000 electricity for meter 41234567890">Electricity</button>
<button data-ex="send a package from Ikeja Lagos to Yaba Lagos">Send quote</button>
<button data-ex="book a ride from Ikeja to the airport">Ride</button>
<button data-ex="find a hotel in Abuja for 2 nights">Stay</button>
<button data-ex="what can you do">Help</button><button data-ex="transfer 1 million to my cousin">Bad request</button></div>
<main id="main"><div class="sys">Session: <b id="sid">…</b> · user: <b>tester</b></div></main>
<footer>
  <input id="inp" placeholder="Message the EDAY assistant… (Enter to send)" autofocus>
  <button id="btn">Send</button>
</footer>
<script>
const main=document.getElementById('main'),inp=document.getElementById('inp'),sidEl=document.getElementById('sid');
let sid=crypto.randomUUID().slice(0,8);
sidEl.textContent=sid;
function add(cls,html){const d=document.createElement('div');d.className=cls;d.innerHTML=html;main.appendChild(d);main.scrollTop=main.scrollHeight;return d;}
function chips(actions){if(!actions||!actions.length)return;const row=document.createElement('div');row.className='chiprow';
 actions.forEach(a=>{const b=document.createElement('button');b.className='chip';b.textContent=a.title;
  b.onclick=()=>{inp.value=a.title.replace(/^[0-9]+\.\s*/,'');send();};row.appendChild(b);});main.appendChild(row);}
async function send(){
 const msg=inp.value.trim();if(!msg)return;inp.value='';add('u',msg.replace(/</g,'&lt;'));
 const t=document.createElement('div');t.className='sys';t.textContent='thinking…';main.appendChild(t);
 try{
  const r=await fetch('/v1/chat',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({session_id:sid,user_id:'tester',channel:'web',message:msg})});
  const j=await r.json();t.remove();
  if(j.data){add('a',j.data.reply.replace(/</g,'&lt;').replace(/\n/g,'<br>'));chips(j.data.actions);}
  else add('a','⚠️ '+JSON.stringify(j.error));
 }catch(e){t.remove();add('a','⚠️ network error: '+e.message);}
}
document.getElementById('btn').onclick=send;
inp.addEventListener('keydown',e=>{if(e.key==='Enter')send();});
document.querySelectorAll('.examples button').forEach(b=>b.onclick=()=>{inp.value=b.dataset.ex;send();});
fetch('/health').then(r=>r.json()).then(j=>{document.getElementById('mode').textContent=
 (j.llm_mode==='mock'?'⚙️ mock mode':'🧠 '+j.model)+' · tools: '+j.tool_mode;
 if(j.llm_mode==='mock')document.getElementById('mode').classList.add('badge-yellow');
 else document.getElementById('mode').style.background='#14532d33',document.getElementById('mode').style.borderColor='#166534',document.getElementById('mode').style.color='#86efac';}).catch(()=>{});
</script></body></html>`;
}
