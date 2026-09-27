// Web panel served at GET /ui (same origin as the API). Single-file SPA:
// login -> profile list (start/stop/view) -> remote viewer over CDP screencast.
// Client-side JS is plain ES2020, no build step required.
// NOTE: embedded script must not contain backticks or ${...} (template literal).
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NullTrace Web Panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, sans-serif; background:#111418; color:#e8eaed; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:#1a1f26; border-bottom:1px solid #2a3038; position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0 auto 0 0; font-weight:600; }
  button { background:#2d6cdf; border:none; color:#fff; padding:7px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
  button:hover { filter:brightness(1.15); }
  button.gray { background:#39424e; }
  button.red { background:#c0392b; }
  button.green { background:#1e8e3e; }
  main { padding:16px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid #232932; }
  th { color:#9aa4b2; font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:12px; }
  .running { background:#12351f; color:#57d97a; }
  .closed { background:#333a44; color:#aab3bf; }
  .row-actions { white-space:nowrap; }
  .row-actions button { margin-right:6px; }
  dialog { background:#1a1f26; color:#e8eaed; border:1px solid #2a3038; border-radius:10px; padding:20px; width:min(420px, 92vw); }
  dialog::backdrop { background:rgba(0,0,0,.6); }
  label { display:block; font-size:13px; color:#9aa4b2; margin:12px 0 4px; }
  input { width:100%; padding:8px 10px; border-radius:6px; border:1px solid #39424e; background:#111418; color:#e8eaed; font-size:14px; }
  #login { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:#111418; z-index:50; }
  #login .card { background:#1a1f26; border:1px solid #2a3038; padding:28px; border-radius:12px; width:min(380px,90vw); }
  #login h2 { margin:0 0 6px; font-size:18px; }
  #login p { color:#9aa4b2; font-size:13px; margin:0 0 8px; }
  #toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:#c0392b; color:#fff; padding:9px 16px; border-radius:8px; font-size:13px; opacity:0; transition:.25s; pointer-events:none; z-index:99;}
  #viewer { position:fixed; inset:0; background:#000; z-index:20; display:none; flex-direction:column; }
  #vbar { display:flex; gap:10px; align-items:center; padding:8px 12px; background:#1a1f26; border-bottom:1px solid #2a3038; font-size:13px; }
  #vwrap { flex:1; overflow:auto; display:flex; align-items:center; justify-content:center; }
  canvas { max-width:100%; max-height:100%; cursor:crosshair; outline:none; }
</style>
</head>
<body>
<header>
    <h2 style="margin-top:0">NullTrace Web Panel</h2>
  <span id="conn" class="badge closed">offline</span>
</header>

<main id="app" style="display:none">
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <button onclick="refresh()">Refresh</button>
    <button onclick="showCreate()">New profile</button>
  </div>
  <table>
    <thead><tr><th>Name</th><th>ID</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</main>

<div id="login" style="display:none">
  <div class="card">
      <div class="brand">NullTrace</div>
    <p id="boot_err" style="color:#e57373;font-size:13px;margin:10px 0 0"></p>
  </div>
</div>

<dialog id="dlg">
  <h3 style="margin:0 0 4px">New profile</h3>
  <label>Name</label><input id="p_name" placeholder="My profile">
  <label>Start URL (optional)</label><input id="p_url" placeholder="https://example.com">
  <label>Proxy (optional)</label><select id="p_proxy" style="width:100%;padding:8px;border-radius:6px;border:1px solid #39424e;background:#111418;color:#e8eaed"></select>
  <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
    <button class="gray" onclick="dlg.close()">Cancel</button>
    <button onclick="createProfile()">Create</button>
  </div>
</dialog>

<div id="viewer">
  <div id="vbar">
    <b id="vname"></b>
    <span id="vstat" style="color:#9aa4b2"></span>
    <span style="flex:1"></span>
    <button class="red" onclick="closeViewer()">Close viewer</button>
  </div>
  <div id="vwrap"><canvas id="cv" tabindex="0"></canvas></div>
</div>

<div id="toast"></div>
<script>
// The panel has no password. The key is fetched from the backend that served this page
// (GET /ui/key, same-origin only) — a plain browser has no Tauri bridge to inject it.
// A previously stored key is reused first so an operator who pasted one keeps it.
var KEY = localStorage.getItem('antidetect_key') || '';
var profiles = [];
var ws = null, vctx = null, vmeta = null, vprofileId = null;

function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.style.opacity=1; setTimeout(function(){t.style.opacity=0},2600); }
function esc(s){ var d=document.createElement('div'); d.textContent=String(s==null?'':s); return d.innerHTML; }

function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'Authorization':'Bearer '+KEY}, opts.headers||{});
  if(opts.body && typeof opts.body==='string') opts.headers['Content-Type']='application/json';
  return fetch(path, opts).then(function(r){ return r.json(); }).then(function(j){
    if(j && j.code !== 0) throw new Error(j.msg || 'error');
    return j.data;
  });
}

function enterApp(){
  localStorage.setItem('antidetect_key', KEY);
  document.getElementById('login').style.display='none';
  document.getElementById('app').style.display='';
  document.getElementById('conn').textContent='connected';
  refresh();
}

/** Ask the backend for the key, then verify it by listing profiles. */
function boot(){
  fetch('/ui/key').then(function(r){ return r.json(); }).then(function(j){
    if(!j || j.code !== 0 || !j.data || !j.data.key){
      throw new Error((j && j.msg) || 'this page is not served by its backend');
    }
    KEY = j.data.key;
    return api('/api/v1/browser/list?page=1&page_size=200');
  }).then(function(){ enterApp(); }).catch(function(e){
    document.getElementById('boot_err').textContent = String(e.message || e);
    document.getElementById('login').style.display='flex';
  });
}

function refresh(){
  api('/api/v1/browser/list?page=1&page_size=200').then(function(d){
    profiles = d.list || [];
    var tb = document.getElementById('rows');
    /*
     * Rows are built as DOM nodes, not as an HTML string.
     *
     * The previous version concatenated each profile id straight into a JS context, as
     *   onclick="stopP('<id>')"
     * esc() is an HTML text escaper and does NOT escape a single quote, so an id containing one
     * closed the JS string and started a new statement. Verified in a real browser: the id
     *   p_1');window.PWNED=1;//
     * produced an onclick whose body ran the injected statement. An id is not necessarily
     * API-supplied either: adoptOrphanedProfileDirs adopts a DIRECTORY NAME as profiles.id
     * provided it starts with p_, so a crafted folder name reached this template.
     *
     * Assigning through textContent and addEventListener removes the parsing context entirely:
     * the id is passed as a JS VALUE to the listener, so no character in it can ever be read as
     * markup or as code.
     */
    tb.textContent = '';
    profiles.forEach(function(p){
      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.textContent = String(p.name == null ? '' : p.name);
      tr.appendChild(tdName);

      var tdId = document.createElement('td');
      tdId.style.color = '#9aa4b2';
      tdId.style.fontSize = '12px';
      tdId.textContent = String(p.id == null ? '' : p.id);
      tr.appendChild(tdId);

      var tdStatus = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + String(p.status == null ? '' : p.status).replace(/[^a-z0-9_-]/gi, '');
      badge.textContent = String(p.status == null ? '' : p.status);
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      var tdActions = document.createElement('td');
      tdActions.className = 'row-actions';
      var profileId = String(p.id == null ? '' : p.id);

      if (p.status === 'running') {
        var stopBtn = document.createElement('button');
        stopBtn.className = 'red';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', function(){ stopP(profileId); });
        tdActions.appendChild(stopBtn);

        var viewBtn = document.createElement('button');
        viewBtn.className = 'green';
        viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', function(){ openViewer(profileId, viewBtn); });
        tdActions.appendChild(viewBtn);
      } else {
        var startBtn = document.createElement('button');
        startBtn.textContent = 'Start';
        startBtn.addEventListener('click', function(){ startP(profileId); });
        tdActions.appendChild(startBtn);
      }

      tr.appendChild(tdActions);
      tb.appendChild(tr);
    });
  }).catch(function(e){
    if(String(e.message).indexOf('unauthorized')>=0){ document.getElementById('login').style.display='flex'; }
    else toast(e.message);
  });
}

function startP(id){
  api('/api/v1/browser/start?user_id='+encodeURIComponent(id)).then(function(){
    setTimeout(refresh, 400);
  }).catch(function(e){ toast(e.message); });
}
function stopP(id){
  api('/api/v1/browser/stop?user_id='+encodeURIComponent(id)).then(function(){
    setTimeout(refresh, 400);
  }).catch(function(e){ toast(e.message); });
}

function showCreate(){
  var sel = document.getElementById('p_proxy');
  sel.innerHTML = '<option value="">— none —</option>';
  api('/api/v1/proxy/list').then(function(d){
    (d.list||[]).forEach(function(px){
      var o=document.createElement('option'); o.value=px.id;
      o.textContent = px.type+'://'+px.host+':'+px.port+(px.country?(' ('+px.country+')'):'');
      sel.appendChild(o);
    });
  }).catch(function(){});
  dlg.showModal();
}
function createProfile(){
  var body = { name: document.getElementById('p_name').value.trim() };
  var u = document.getElementById('p_url').value.trim();
  if(u) body.start_urls=[u];
  var px = document.getElementById('p_proxy').value;
  if(px) body.proxy_id = px;
  if(!body.name){ toast('Name required'); return; }
  api('/api/v1/browser-profile/create', {method:'POST', body:JSON.stringify(body)}).then(function(){
    dlg.close(); refresh();
  }).catch(function(e){ toast(e.message); });
}

/* ---------- viewer ---------- */
function openViewer(id, btn){
  vprofileId = id;
  vmeta = null;
  var cv = document.getElementById('cv');
  vctx = cv.getContext('2d');
  document.getElementById('vname').textContent = btn ? (btn.closest('tr').children[0].textContent) : id;
  document.getElementById('vstat').textContent = 'connecting…';
  document.getElementById('viewer').style.display='flex';
  cv.focus();
  var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var url = proto + location.host + '/cdp-view/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(KEY);
  ws = new WebSocket(url);
  ws.onopen = function(){ document.getElementById('vstat').textContent='live'; };
  ws.onerror = function(){ document.getElementById('vstat').textContent='connection error'; };
  ws.onclose = function(ev){ if(document.getElementById('viewer').style.display!=='none'){ document.getElementById('vstat').textContent='disconnected'+(ev.reason?(': '+ev.reason):''); } };
  ws.onmessage = function(ev){
    var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
    if(m.t==='frame' && m.d){
      vmeta = { w:m.w, h:m.h };
      var img = new Image();
      img.onload = function(){
        var cv=document.getElementById('cv');
        if(cv.width!==m.w||cv.height!==m.h){ cv.width=m.w; cv.height=m.h; }
        vctx.drawImage(img,0,0);
      };
      img.src = 'data:image/jpeg;base64,'+m.d;
    } else if(m.t==='error'){
      document.getElementById('vstat').textContent = m.msg;
      toast(m.msg);
    } else if(m.t==='closed'){
      document.getElementById('vstat').textContent = 'browser closed';
      setTimeout(function(){ closeViewer(); refresh(); }, 900);
    }
  };
}
function closeViewer(){
  if(ws){ try{ws.close()}catch(e){} ws=null; }
  document.getElementById('viewer').style.display='none';
  refresh();
}

function devCoords(ev){
  var cv=document.getElementById('cv'), r=cv.getBoundingClientRect();
  if(!vmeta||!vmeta.w) return null;
  return {
    x:(ev.clientX-r.left)*(vmeta.w/r.width),
    y:(ev.clientY-r.top)*(vmeta.h/r.height)
  };
}
function sendMouse(evObj){
  if(ws && ws.readyState===1) ws.send(JSON.stringify(Object.assign({t:'m'}, evObj)));
}
document.getElementById('cv').addEventListener('pointerdown', function(ev){
  ev.preventDefault(); this.setPointerCapture(ev.pointerId); this.focus();
  var c=devCoords(ev); if(c) sendMouse({ev:'down', x:c.x, y:c.y, b:ev.button===2?'right':(ev.button===1?'middle':'left'), c:1});
});
document.getElementById('cv').addEventListener('pointerup', function(ev){
  var c=devCoords(ev); if(c) sendMouse({ev:'up', x:c.x, y:c.y, b:ev.button===2?'right':(ev.button===1?'middle':'left'), c:1});
});
document.getElementById('cv').addEventListener('pointermove', function(ev){
  if(ev.pointerType==='touch' && ev.buttons===0) return;
  var c=devCoords(ev); if(c) sendMouse({ev:'move', x:c.x, y:c.y});
});
document.getElementById('cv').addEventListener('wheel', function(ev){
  ev.preventDefault();
  var c=devCoords(ev); if(!c) return;
  sendMouse({ev:'wheel', x:c.x, y:c.y, dy:ev.deltaY, dx:ev.deltaX});
}, {passive:false});
document.getElementById('cv').addEventListener('contextmenu', function(ev){ ev.preventDefault(); });

window.addEventListener('keydown', function(ev){
  if(document.getElementById('viewer').style.display==='none') return;
  var tag=(document.activeElement&&document.activeElement.tagName)||'';
  if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
  ev.preventDefault();
  if(ws && ws.readyState===1) ws.send(JSON.stringify({
    t:'k', ev:'down', key:ev.key, code:ev.code, vk:ev.keyCode,
    text: (ev.key.length===1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) ? ev.key : undefined
  }));
}, true);
window.addEventListener('keyup', function(ev){
  if(document.getElementById('viewer').style.display==='none') return;
  ev.preventDefault();
  if(ws && ws.readyState===1) ws.send(JSON.stringify({
    t:'k', ev:'up', key:ev.key, code:ev.code, vk:ev.keyCode
  }));
}, true);

// A stored key is tried first (an older build may have left one); anything else boots
// straight from /ui/key. There is no password prompt to fall back to.
if(KEY){
  api('/api/v1/browser/list?page=1&page_size=200').then(enterApp).catch(boot);
} else {
  boot();
}
</script>
</body>
</html>`;
