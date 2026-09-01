// Self-contained HTML served by the Worker: a landing page and a live dashboard.
// No external assets (CSP-friendly). Design language matches the plan docs:
// Bricolage Grotesque + IBM Plex, terracotta accent, light/dark aware.

const HEAD = (title: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style></head><body>`;

const CSS = `
:root{--bg:#FBFAF8;--surface:#F2F0EC;--card:#fff;--ink:#22252B;--muted:#5D6470;--line:#E0DDD6;--accent:#C4571A;--accent-soft:#F7E8DC;--good:#2B7A5B;--mono:"IBM Plex Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#191B1F;--surface:#22252B;--card:#212429;--ink:#EAE7E1;--muted:#9AA0AB;--line:#33373F;--accent:#E8834A;--accent-soft:#3A2A1E;--good:#5BBF97}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "IBM Plex Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
h1,h2,h3{font-family:"Bricolage Grotesque",sans-serif;line-height:1.1;text-wrap:balance;margin:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.brand{font-family:"Bricolage Grotesque";font-weight:700;font-size:1.05rem;letter-spacing:-.01em}
.brand .dot{color:var(--accent)}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:3rem}
.top nav a{color:var(--muted);font-size:.9rem;margin-left:1.2rem}
.eyebrow{font:500 .74rem/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:1rem}
.hero h1{font-size:clamp(2.2rem,6vw,3.4rem);font-weight:700;letter-spacing:-.02em}
.hero p.sub{font-size:1.2rem;color:var(--muted);max-width:36rem;margin:1rem 0 2rem}
.cmd{display:flex;align-items:center;gap:.75rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem;font-family:var(--mono);font-size:1rem;max-width:30rem}
.cmd .prompt{color:var(--accent)}
.cmd code{flex:1;overflow-x:auto;white-space:nowrap}
.copy{border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:6px;padding:.35rem .6rem;font:500 .8rem var(--mono);cursor:pointer}
.copy:hover{color:var(--ink);border-color:var(--accent)}
.copy.done{color:var(--good);border-color:var(--good)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:2.5rem 0}
@media(max-width:640px){.row{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem 1.4rem}
.card h3{font-size:1.05rem;margin-bottom:.4rem}
.card p{color:var(--muted);font-size:.92rem;margin:.2rem 0 0}
.steps{counter-reset:s;list-style:none;padding:0;margin:2rem 0}
.steps li{counter-increment:s;position:relative;padding:.5rem 0 .5rem 2.4rem;color:var(--muted)}
.steps li::before{content:counter(s);position:absolute;left:0;top:.45rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--accent-soft);color:var(--accent);font:600 .85rem var(--mono);display:grid;place-items:center}
.steps li b{color:var(--ink)}
.foot{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem;display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem}
/* dashboard */
.tokenbar{display:flex;gap:.6rem;margin:1.5rem 0;flex-wrap:wrap}
.tokenbar input{flex:1;min-width:16rem;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;font-family:var(--mono);font-size:.85rem;color:var(--ink)}
.btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:.6rem 1.1rem;font-weight:600;cursor:pointer;font-size:.9rem}
.btn:hover{filter:brightness(1.05)}.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.status{display:inline-flex;align-items:center;gap:.5rem;font-size:.85rem;color:var(--muted);margin-bottom:1rem}
.dot-live{width:.6rem;height:.6rem;border-radius:50%;background:var(--muted)}
.dot-live.on{background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 25%,transparent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-top:1rem}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem}
.panel h3{font-size:1rem;display:flex;justify-content:space-between;align-items:center}
.count{font:500 .75rem var(--mono);color:var(--muted);background:var(--surface);border-radius:20px;padding:.15rem .6rem}
.item{border-top:1px solid var(--line);padding:.7rem 0;display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start}
.item:first-of-type{border-top:none}
.item .body{font-size:.92rem}
.item .meta{font:.72rem var(--mono);color:var(--muted);margin-top:.2rem}
.chip{font:.68rem var(--mono);color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:.1rem .4rem}
.x{border:none;background:none;color:var(--muted);cursor:pointer;font-size:1.1rem;line-height:1;padding:.1rem .3rem}
.x:hover{color:var(--accent)}
.add{display:flex;gap:.5rem;margin-top:1rem}
.add input,.add textarea{flex:1;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:.5rem .7rem;font:inherit;font-size:.88rem;color:var(--ink)}
.empty{color:var(--muted);font-size:.9rem;padding:1rem 0;text-align:center}
.flash{animation:flash 1.2s ease}
@keyframes flash{0%{background:var(--accent-soft)}100%{background:transparent}}
.hint{font-size:.85rem;color:var(--muted);margin-top:.5rem}
`;

export function landingPage(baseUrl: string): string {
  const npx = "npx agentprofile";
  return (
    HEAD("agentprofile — your agent's identity, everywhere") +
    `<div class="wrap">
<div class="top"><span class="brand">agent<span class="dot">·</span>profile</span>
<nav><a href="/app">Dashboard</a><a href="/setup-prompt">Setup prompt</a><a href="https://github.com/everyai-com/agentprofile">GitHub</a></nav></div>

<section class="hero">
<div class="eyebrow">open source · zero-knowledge · self-hostable</div>
<h1>Your agent's identity, everywhere.</h1>
<p class="sub">One profile — skills, credentials, and memory — synced to every agent tool through a single MCP URL. Teach Claude Code something; Cursor already knows.</p>
<div class="cmd"><span class="prompt">$</span><code id="npx">${npx}</code><button class="copy" data-copy="${npx}">Copy</button></div>
<p class="hint">No signup. Creates an anonymous profile and wires up every MCP client it finds.</p>
</section>

<div class="row">
<div class="card"><h3>🧠 Shared memory</h3><p>Every tool reads and writes the same facts, with provenance. Say it once, anywhere.</p></div>
<div class="card"><h3>📦 Portable skills</h3><p>Add a SKILL.md once; it's delivered to each client in its own format.</p></div>
<div class="card"><h3>🔐 Zero-knowledge secrets</h3><p>API keys encrypted on your device. The server stores ciphertext it can't read. <em>(Phase 3)</em></p></div>
<div class="card"><h3>☁️ Your Cloudflare</h3><p>Self-host in one click on your own account, free tier and all. Or use the hosted cloud.</p></div>
</div>

<h2>How it works</h2>
<ol class="steps">
<li>Run <b>${npx}</b> — it creates your profile and configures your tools.</li>
<li><b>Restart</b> your agent tools so they load the new MCP server.</li>
<li>In one tool: <b>"Remember that I prefer pnpm over npm."</b></li>
<li>In another: <b>"What package manager do I prefer?"</b> — it knows.</li>
</ol>

<p><a href="/app">Open the live dashboard →</a> &nbsp; watch memories appear in real time as your agents write them.</p>

<div class="foot"><span>agentprofile · Apache-2.0</span><span>Phase 1 · skills + memory sync</span></div>
</div>
<script>
document.querySelectorAll('.copy').forEach(b=>b.addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copied';b.classList.add('done');
  setTimeout(()=>{b.textContent='Copy';b.classList.remove('done')},1400)}catch(e){}
}));
</script></body></html>`
  );
}

export function dashboardPage(baseUrl: string): string {
  return (
    HEAD("agentprofile — dashboard") +
    `<div class="wrap">
<div class="top"><span class="brand"><a href="/" style="color:inherit">agent<span class="dot">·</span>profile</a></span>
<nav><a href="/">Home</a><a href="https://github.com/everyai-com/agentprofile">GitHub</a></nav></div>

<div class="eyebrow">live dashboard</div>
<h1 style="font-size:2rem">Your profile, in real time</h1>
<p style="color:var(--muted)">Paste your token to watch skills and memory sync live. When any agent calls <code>remember</code>, it appears here instantly.</p>

<div class="tokenbar">
<input id="token" placeholder="ap_… paste your token (from npx agentprofile)" autocomplete="off" spellcheck="false">
<button class="btn" id="connect">Connect</button>
<button class="btn ghost" id="new">Create new</button>
</div>
<div class="status"><span class="dot-live" id="live"></span><span id="statusText">Not connected</span></div>

<div class="grid2">
<div class="panel">
<h3>Memory <span class="count" id="mcount">0</span></h3>
<div id="facts"><div class="empty">No memories yet.</div></div>
<div class="add"><input id="factInput" placeholder="Remember something…"><input id="scopeInput" placeholder="scope" style="max-width:6rem"><button class="btn" id="addFact">Add</button></div>
</div>
<div class="panel">
<h3>Skills <span class="count" id="scount">0</span></h3>
<div id="skills"><div class="empty">No skills installed.</div></div>
<div class="add"><textarea id="skillInput" rows="2" placeholder="Paste a SKILL.md (with name: and description: frontmatter)"></textarea><button class="btn" id="addSkill">Add</button></div>
</div>
</div>
<p class="hint" id="connHint"></p>

<div class="foot"><span>Tip: run <code>npx agentprofile</code>, then paste the printed token here.</span></div>
</div>
<script>${DASH_JS}</script></body></html>`
  );
}

const DASH_JS = `
const $=s=>document.querySelector(s);
let ws=null, token=localStorage.getItem('ap_token')||'';
if(token) $('#token').value=token;

function setLive(on,text){$('#live').classList.toggle('on',on);$('#statusText').textContent=text}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

async function rpc(method,params){
  const r=await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token,'x-mcp-client':'dashboard'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return r.json();
}
async function callTool(name,args){const j=await rpc('tools/call',{name,arguments:args||{}});return j.result?.content?.[0]?.text}

let facts=[],skills=[];
function render(flashId){
  $('#mcount').textContent=facts.length; $('#scount').textContent=skills.length;
  $('#facts').innerHTML = facts.length? facts.map(f=>
    '<div class="item'+(f.id===flashId?' flash':'')+'"><div><div class="body">'+esc(f.body)+'</div><div class="meta"><span class="chip">'+esc(f.scope)+'</span> &nbsp;'+esc(f.learned||'')+'</div></div><button class="x" data-forget="'+f.id+'">×</button></div>'
  ).join('') : '<div class="empty">No memories yet. Add one, or ask an agent to remember something.</div>';
  $('#skills').innerHTML = skills.length? skills.map(s=>
    '<div class="item"><div><div class="body"><b>'+esc(s.slug)+'</b> <span class="meta">v'+esc(s.version)+'</span></div><div class="meta">'+esc(s.summary||'')+'</div></div></div>'
  ).join('') : '<div class="empty">No skills yet. Paste a SKILL.md below.</div>';
  document.querySelectorAll('[data-forget]').forEach(b=>b.onclick=async()=>{await callTool('forget',{id:b.dataset.forget})});
}

function connectWS(){
  if(ws){try{ws.close()}catch(e){}}
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host+'/live?token='+encodeURIComponent(token));
  setLive(false,'Connecting…');
  ws.onopen=()=>setLive(true,'Live — connected');
  ws.onclose=()=>{setLive(false,'Disconnected');};
  ws.onerror=()=>setLive(false,'Connection error — check the token');
  ws.onmessage=ev=>{
    const m=JSON.parse(ev.data);
    if(m.type==='snapshot'){facts=m.facts;skills=m.skills;render();}
    else if(m.type==='memory_added'){facts.unshift({id:m.id,body:m.fact,scope:m.scope,learned:(m.client||'agent')+', just now'});render(m.id);toast('Memory added by '+(m.client||'an agent'));}
    else if(m.type==='memory_removed'){facts=facts.filter(f=>f.id!==m.id);render();}
    else if(m.type==='skill_added'){callTool('list_skills').then(()=>refresh());}
  };
}
async function refresh(){ws&&ws.readyState===1&&ws.send('refresh')}

let toastEl;
function toast(msg){
  if(!toastEl){toastEl=document.createElement('div');toastEl.style.cssText='position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:.6rem 1rem;border-radius:8px;font-size:.85rem;z-index:9;transition:opacity .3s';document.body.appendChild(toastEl)}
  toastEl.textContent=msg;toastEl.style.opacity='1';clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.style.opacity='0',2200);
}

$('#connect').onclick=()=>{token=$('#token').value.trim();if(!token)return;localStorage.setItem('ap_token',token);connectWS();};
$('#new').onclick=async()=>{const r=await fetch('/profiles',{method:'POST'});const j=await r.json();token=j.token;$('#token').value=token;localStorage.setItem('ap_token',token);$('#connHint').innerHTML='New profile created. Connect it to a tool with: <code>npx agentprofile</code> (token already saved here).';connectWS();};
$('#addFact').onclick=async()=>{const v=$('#factInput').value.trim();if(!v)return;$('#factInput').value='';await callTool('remember',{fact:v,scope:$('#scopeInput').value.trim()||'general'});};
$('#addSkill').onclick=async()=>{const body=$('#skillInput').value.trim();if(!body)return;const slug=(body.match(/name:\\s*([a-z0-9-]+)/i)||[])[1]||('skill-'+Date.now());const summary=(body.match(/description:\\s*(.+)/i)||[])[1]||'';await fetch('/skills',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({slug,summary,body})});$('#skillInput').value='';};
$('#factInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('#addFact').click()});

if(token) connectWS();
`;

export function setupPromptText(baseUrl: string): string {
  return `You are helping me set up "agentprofile" — a service that syncs my agent skills and
memory across all my AI tools through one MCP server.

Please do the following, checking with me before any step that changes my config:

1. Run this in my terminal and capture the token it prints:
     npx agentprofile init --server ${baseUrl}
   (This creates an anonymous profile and auto-configures the MCP clients you find:
    Claude Code and Cursor.)

2. Tell me which tools it configured, and remind me I must RESTART each tool for it to
   load the new MCP server (most MCP clients only read server config at startup).

3. After I restart, verify it works by asking me to run this cross-tool test:
     - In one tool, tell it: "Remember that I prefer pnpm over npm."
     - In another tool, ask: "What package manager do I prefer?"
   It should recall the fact. If it does, setup succeeded.

4. If anything fails, run:  npx agentprofile doctor --server ${baseUrl}
   and walk me through the fix it prints.

My dashboard is at ${baseUrl}/app — I can paste the token there to watch memory sync live.`;
}
