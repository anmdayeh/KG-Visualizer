/* app.js final v2: fixes & note popover */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function resizeCanvas(){
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(800, Math.floor(rect.width * devicePixelRatio));
  canvas.height = Math.max(600, Math.floor(rect.height * devicePixelRatio));
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
addEventListener('resize', resizeCanvas);
resizeCanvas();

function randRange(a,b){ return a + Math.random()*(b-a); }
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function uid(){ return Math.random().toString(36).slice(2,10); }

const PHYS = { FEATURE_COHESION:0.000003, GROUP_FOLLOW:0.0001, EDGE_SPRING_K:0.00012, EDGE_SPRING_RANGE:6.0 };

let world = { nodes:[], edges:[], camera:{x:0,y:0,scale:1}, meta:{ nextGroupIx:0 }, settings:{ showNotes:true, showIndicators:true } };

let selectedNodeId = null;
let selectedGroupId = null;

// Multi-select state: ids of currently selected nodes
const selectedNodes = new Set();

// Dragging a selection (multiple nodes)
let dragSelection = null;           // array of node objects being dragged
let dragStartPositions = null;      // { id: {x,y} } initial positions at drag start
let dragOriginW = null;             // world coords of pointer at drag start


const undoStack = [], redoStack = [];
function pushUndo(){ undoStack.push(JSON.parse(JSON.stringify(world))); if(undoStack.length>120) undoStack.shift(); redoStack.length=0; }
function undo(){ if(undoStack.length){ redoStack.push(JSON.parse(JSON.stringify(world))); world = undoStack.pop(); refreshUI(); } }
function redo(){ if(redoStack.length){ undoStack.push(JSON.parse(JSON.stringify(world))); world = redoStack.pop(); refreshUI(); } }
document.addEventListener('keydown', (e)=>{ if(e.ctrlKey && e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); } if(e.ctrlKey && e.key.toLowerCase()==='y'){ e.preventDefault(); redo(); } });

// Press ESC to clear selection & hide notes / popovers
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    selectedNodeId = null;
    selectedGroupId = null;
    hoverNodeId = null;
    if (typeof hideNotePopover === 'function') hideNotePopover();
    refreshUI();
  }
});


let isPanning=false, panStart={x:0,y:0}, dragNode=null, dragOffset={x:0,y:0}, creatingEdgeFrom=null, hoverNodeId=null, camStart={x:0,y:0}, isResizing=false;
let mouse={x:0,y:0};

function toWorld(px,py){ const c=world.camera; return { x:(px/c.scale)+c.x, y:(py/c.scale)+c.y }; }
function toScreen(wx,wy){ const c=world.camera; return { x:(wx - c.x)*c.scale, y:(wy - c.y)*c.scale }; }

function getEdgeImage(e){ if(!e.imageDataUrl) return null; const img=new Image(); img.src=e.imageDataUrl; return img; }

function pointToSegmentDistance(px,py,ax,ay,bx,by){ const abx=bx-ax, aby=by-ay; const apx=px-ax, apy=py-ay; const ab2=abx*abx+aby*aby||1e-6; let t=(apx*abx+apy*aby)/ab2; t=Math.max(0,Math.min(1,t)); const cx=ax+abx*t, cy=ay+aby*t; const dx=px-cx, dy=py-cy; return Math.hypot(dx,dy); }

function colorFor(ix){ const palette=['#6ee7b7','#93c5fd','#f9a8d4','#fdba74','#a5b4fc','#86efac','#67e8f9','#fca5a5','#fcd34d','#c4b5fd']; return palette[ix%palette.length]; }
function randomPointInRing(r1=150,r2=500){ const t=Math.random()*Math.PI*2; const r=randRange(r1,r2); return {x:Math.cos(t)*r, y:Math.sin(t)*r}; }

// rebuild visibility tree (collapsible groups) and wire click handlers
function rebuildVisibilityTree(){
  const tree = document.getElementById('visibility-tree');
  if(!tree) return;
  tree.innerHTML = '';

  const allGroups = world.nodes.filter(n=>n.type==='group').sort((a,b)=>a.name.localeCompare(b.name));

  for(const g of allGroups){
    const details = document.createElement('details');
    details.setAttribute('data-group-id', g.id);
    details.open = false;

    const sum = document.createElement('summary');
    sum.className = 'visibility-group-summary';

    const sumRow = document.createElement('div');
    sumRow.className = 'visibility-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = g.visible !== false;

    // Prevent clicks on the checkbox from toggling the <details> element
    chk.addEventListener('click', (ev) => { ev.stopPropagation(); });
    chk.addEventListener('change', (ev) => { pushUndo(); g.visible = chk.checked; refreshUI(); });

    const label = document.createElement('span');
    label.textContent = g.name;
    label.style.flex = '1';
    label.style.marginLeft = '8px';

    const noteBtn = document.createElement('button');
    noteBtn.className = 'small';
    noteBtn.textContent = g.note ? '📝' : '✎';
    noteBtn.title = 'Edit note';
    noteBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openNoteModalForNode(g); });

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = g.color + '33';
    badge.style.border = '1px solid ' + g.color;
    badge.textContent = 'Group';

    // optional indicator
    if (world.settings && world.settings.showIndicators) {
      const ni = document.createElement('span');
      ni.className = 'note-indicator';
      ni.textContent = g.note ? '•' : '';
      ni.style.color = '#ffd166';
      ni.style.marginLeft = '6px';
      sumRow.appendChild(ni);
    }

    sumRow.appendChild(chk);
    sumRow.appendChild(label);
    sumRow.appendChild(noteBtn);
    sumRow.appendChild(badge);
    sum.appendChild(sumRow);

    // clicking the whole row focuses the group (but does not toggle the details)
    sumRow.addEventListener('click', (ev) => { ev.stopPropagation(); onSidebarItemClick(g.id); });

    details.appendChild(sum);

    const ul = document.createElement('div');
    ul.style.display = 'flex';
    ul.style.flexDirection = 'column';
    ul.style.gap = '6px';
    ul.style.padding = '8px';

    const feats = world.nodes.filter(n=>n.type==='feature' && n.groupId===g.id).sort((a,b)=>a.name.localeCompare(b.name));
    for(const f of feats){
      const row = document.createElement('div');
      row.className = 'visibility-feature-row';
      row.setAttribute('data-feature-id', f.id);
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.padding = '4px';
      row.style.borderRadius = '6px';

      const fRowLeft = document.createElement('div');
      fRowLeft.style.display='flex';
      fRowLeft.style.alignItems='center';

      const fchk = document.createElement('input');
      fchk.type='checkbox';
      fchk.checked = f.visible !== false;

      // prevent details toggle on checkbox click
      fchk.addEventListener('click', (ev) => { ev.stopPropagation(); });
      fchk.addEventListener('change', (ev) => { pushUndo(); f.visible = fchk.checked; refreshUI(); });

      const fname = document.createElement('span');
      fname.textContent = ' ' + f.name;
      fname.style.marginLeft = '8px';

      fRowLeft.appendChild(fchk);
      fRowLeft.appendChild(fname);

      const fbadge = document.createElement('span');
      fbadge.className = 'badge';
      fbadge.textContent = 'Feature';
      fbadge.style.background = g.color + '22';
      fbadge.style.border = '1px dashed ' + g.color;

      const fnoteBtn = document.createElement('button');
      fnoteBtn.className = 'small';
      fnoteBtn.textContent = f.note ? '📝' : '✎';
      fnoteBtn.title = 'Edit note';
      fnoteBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openNoteModalForNode(f); });

      // optional indicator
      if (world.settings && world.settings.showIndicators) {
        const fi = document.createElement('span');
        fi.className = 'note-indicator';
        fi.textContent = f.note ? '•' : '';
        fi.style.color = '#ffd166';
        fi.style.marginLeft = '6px';
        fRowLeft.appendChild(fi);
      }

      row.appendChild(fRowLeft);
      row.appendChild(fnoteBtn);
      row.appendChild(fbadge);

      // clicking the row focuses the feature (does not toggle parent <details>)
      row.addEventListener('click', (ev)=>{ ev.stopPropagation(); onSidebarItemClick(f.id); });

      ul.appendChild(row);
    }

    details.appendChild(ul);
    tree.appendChild(details);
  }

  // Populate feature-group select
  const sel = document.getElementById('feature-group');
  if(sel){
    sel.innerHTML = '';
    for(const g of allGroups){
      const opt = document.createElement('option');
      opt.value = g.id; opt.textContent = g.name;
      sel.appendChild(opt);
    }
  }
}

(function setupSidebarResizer(){
  const handle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  if(!handle || !sidebar) return;
  let active = false;
  let startX = 0;
  let startW = 0;
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    active = true;
    startX = ev.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.setPointerCapture?.(ev.pointerId);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('pointermove', (ev) => {
    if(!active) return;
    const dx = ev.clientX - startX;
    const newW = Math.max(140, Math.min(1100, startW + dx));
    sidebar.style.width = newW + 'px';
    resizeCanvas(); // keep canvas in sync
  });
  window.addEventListener('pointerup', (ev) => {
    if(!active) return;
    active = false;
    try { handle.releasePointerCapture?.(ev.pointerId); } catch(e){}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// highlighting & flyTo
function highlightInSidebar(nodeId){
  document.querySelectorAll('#visibility-tree .highlight').forEach(x=>x.classList.remove('highlight'));
  selectedNodeId = nodeId; selectedGroupId = null;
  const node = world.nodes.find(n=>n.id===nodeId); if(!node) return;
  if(node.type==='feature'){ selectedGroupId = node.groupId; const det = document.querySelector(`#visibility-tree details[data-group-id="${node.groupId}"]`); if(det) det.open = true; const el = document.querySelector(`#visibility-tree .visibility-feature-row[data-feature-id="${node.id}"]`); if(el) el.classList.add('highlight'); const s = document.querySelector(`#visibility-tree details[data-group-id="${node.groupId}"] > summary`); if(s) s.classList.add('highlight'); } else { selectedGroupId = node.id; const det = document.querySelector(`#visibility-tree details[data-group-id="${node.id}"]`); if(det){ det.open=true; det.querySelector('summary')?.classList.add('highlight'); } }
}

function flyTo(node, opts={}){
  if(!node) return;
  const dur = opts.duration ?? 450; const targetScale = clamp(opts.scale ?? world.camera.scale, 0.5, 3.0);
  const start = { x:world.camera.x, y:world.camera.y, s:world.camera.scale };
  const screenW = canvas.width / devicePixelRatio, screenH = canvas.height / devicePixelRatio;
  const target = { s: targetScale, x: node.x - (screenW/2)/targetScale, y: node.y - (screenH/2)/targetScale };
  const t0 = performance.now();
  function ease(p){ return p<0.5?2*p*p:-1+(4-2*p)*p; }
  (function step(now){ const p = Math.min(1,(now-t0)/dur); const e=ease(p); world.camera.scale = start.s + (target.s - start.s)*e; world.camera.x = start.x + (target.x - start.x)*e; world.camera.y = start.y + (target.y - start.y)*e; if(p<1) requestAnimationFrame(step); })(t0);
}

// NOTE modal
const noteModal = document.getElementById('note-modal');
const noteTargetName = document.getElementById('note-target-name');
const noteText = document.getElementById('note-text');
const noteSave = document.getElementById('note-save');
const noteCancel = document.getElementById('note-cancel');
const noteClear = document.getElementById('note-clear');
let noteTarget = null;
function openNoteModalForNode(node){ noteTarget = node; noteTargetName.textContent = `${node.type.toUpperCase()}: ${node.name}`; noteText.value = node.note || ''; noteModal.classList.remove('hidden'); }
noteSave.onclick = ()=>{ if(!noteTarget) return; pushUndo(); noteTarget.note = noteText.value.trim() || null; noteModal.classList.add('hidden'); noteTarget=null; refreshUI(); }
noteCancel.onclick = ()=>{ noteModal.classList.add('hidden'); noteTarget=null; }
noteClear.onclick = ()=>{ if(!noteTarget) return; pushUndo(); noteTarget.note = null; noteModal.classList.add('hidden'); noteTarget=null; refreshUI(); }

// note popover element
const notePopover = document.getElementById('note-popover');

function showNotePopoverForNode(node, screenPos){
  if(!node || !node.note || !world.settings.showNotes) { notePopover.classList.add('hidden'); return; }
  notePopover.textContent = node.note;
  notePopover.style.left = screenPos.x + 'px';
  notePopover.style.top = (screenPos.y - 12) + 'px';
  notePopover.classList.remove('hidden');
}
function hideNotePopover(){ notePopover.classList.add('hidden'); }

// physics
function physicsTick(dt){
  const groups = world.nodes.filter(n=>n.type==='group');
  const featByGroup = new Map(groups.map(g=>[g.id,[]]));
  for(const f of world.nodes.filter(n=>n.type==='feature' && n.visible!==false)) featByGroup.get(f.groupId)?.push(f);
  for(const g of groups){
    const feats = featByGroup.get(g.id) || [];
    if(feats.length){
      let cx=0, cy=0;
      for(const f of feats){ cx+=f.x; cy+=f.y; }
      cx/=feats.length; cy/=feats.length;
      g.x += (cx - g.x) * PHYS.GROUP_FOLLOW;
      g.y += (cy - g.y) * PHYS.GROUP_FOLLOW;
      for(const f of feats){ const dx=g.x-f.x, dy=g.y-f.y; f.x += dx * PHYS.FEATURE_COHESION; f.y += dy * PHYS.FEATURE_COHESION; }
    }
  }
  for(const e of world.edges){
    if(e.visible===false) continue;
    const a = world.nodes.find(n=>n.id===e.aId), b = world.nodes.find(n=>n.id===e.bId);
    if(!a||!b||a.visible===false||b.visible===false) continue;
    const d = dist(a,b), target=(a.r+b.r)*2.0;
    if(d > target * PHYS.EDGE_SPRING_RANGE){
      const k = PHYS.EDGE_SPRING_K; const dirx=(b.x-a.x)/d, diry=(b.y-a.y)/d; const f=(d - target*PHYS.EDGE_SPRING_RANGE)*k;
      a.x += dirx * f * 0.5; a.y += diry * f * 0.5; b.x -= dirx * f * 0.5; b.y -= diry * f * 0.5;
    }
  }
}

// draw
function draw(){
  const {x:cx,y:cy,scale} = world.camera; ctx.save(); ctx.translate(-cx*scale, -cy*scale); ctx.scale(scale, scale);

  // edges
  for(const e of world.edges){
    if(e.visible===false) continue;
    const a = world.nodes.find(n=>n.id===e.aId), b = world.nodes.find(n=>n.id===e.bId);
    if(!a||!b||a.visible===false||b.visible===false) continue;
    ctx.save();
    const highlighted = (hoverNodeId && (a.id===hoverNodeId || b.id===hoverNodeId)) || (selectedNodeId && (a.id===selectedNodeId || b.id===selectedNodeId));
    ctx.lineWidth = highlighted ? 3/scale : 1.2/scale;
    ctx.strokeStyle = highlighted ? '#ffffff' : '#ccccff88';
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    const midx=(a.x+b.x)/2, midy=(a.y+b.y)/2;
    if(e.label){ ctx.fillStyle='#e6e9ff'; ctx.font=`${12/scale}px sans-serif`; ctx.textAlign='center'; ctx.fillText(e.label, midx, midy - (e.imageDataUrl?(e.imageSize/2 + 8)/scale:8/scale)); }
    if(e.imageDataUrl){ const img=getEdgeImage(e); if(img && img.complete){ const w=e.imageSize, h=e.imageSize; ctx.drawImage(img, midx-w/2, midy-h/2, w, h); } }
    ctx.restore();
  }

  // nodes
  for(const n of world.nodes){
    if(n.visible===false) continue;
    ctx.save();
    const isHover = (hoverNodeId===n.id);
    const isSelected = (selectedNodeId===n.id) || (selectedGroupId && (n.id===selectedGroupId || n.groupId===selectedGroupId));
    if(isHover || isSelected){ ctx.shadowColor='#ffffffcc'; ctx.shadowBlur = 14/scale; } else ctx.shadowBlur = 0;
    if(n.type==='group'){ ctx.fillStyle=n.color+'55'; ctx.strokeStyle=n.color; roundedRect(ctx,n.x-n.r,n.y-n.r,n.r*2,n.r*2,n.r*0.35); ctx.fill(); ctx.lineWidth = 2/scale; ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,Math.PI*2); ctx.fillStyle=n.color+'bb'; ctx.fill(); ctx.lineWidth=2/scale; ctx.strokeStyle=n.color; ctx.stroke(); }
    ctx.fillStyle='#e6e9ff'; ctx.font=`${12/scale}px sans-serif`; ctx.textAlign='center';
    ctx.fillText(n.name, n.x, n.y + (n.type==='group' ? -n.r-6/scale : n.r+14/scale));
    if(n.note && world.settings.showIndicators){
      ctx.beginPath(); ctx.fillStyle='#ffd166'; ctx.arc(n.x + n.r*0.6, n.y - n.r*0.6, 6/scale, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  // temp edge creation
  if(creatingEdgeFrom){
    const mouseW = toWorld(mouse.x, mouse.y); const a = world.nodes.find(n=>n.id===creatingEdgeFrom);
    if(a && (a.visible!==false)){ ctx.save(); ctx.lineWidth = 1/scale; ctx.setLineDash([8/scale, 6/scale]); ctx.strokeStyle = '#ffffff66'; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(mouseW.x, mouseW.y); ctx.stroke(); ctx.restore(); }
  }

  ctx.restore();
}

function roundedRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

// interactions
canvas.addEventListener('mousemove',(e)=>{
  mouse.x = e.offsetX; mouse.y = e.offsetY;

  if (isPanning) {
    const w1 = toWorld(mouse.x, mouse.y), w0 = toWorld(panStart.x, panStart.y);
    world.camera.x = camStart.x - (w1.x - w0.x);
    world.camera.y = camStart.y - (w1.y - w0.y);
  }
  // If we have a selection drag in progress, move all selected nodes together
  else if (dragSelection && dragSelection.length) {
    const wNow = toWorld(mouse.x, mouse.y);
    const dx = wNow.x - dragOriginW.x;
    const dy = wNow.y - dragOriginW.y;
    for (const nd of dragSelection) {
      const start = dragStartPositions[nd.id];
      if (!start) continue;
      nd.x = start.x + dx;
      nd.y = start.y + dy;
    }
  }
  // Single-node drag (unchanged behavior)
  else if (dragNode) {
    const w = toWorld(mouse.x, mouse.y);
    if (isResizing) {
      const r = Math.max(12, Math.hypot(w.x - dragNode.x, w.y - dragNode.y));
      dragNode.r = r;
    } else {
      dragNode.x = w.x + dragOffset.x;
      dragNode.y = w.y + dragOffset.y;
    }
  }

  // recompute hover using the usual pick
  hoverNodeId = pickNode(mouse.x, mouse.y)?.id || null;

  // show note popover on hover if enabled
  const hn = world.nodes.find(n=>n.id===hoverNodeId);
  if (hn && hn.note && world.settings.showNotes) {
    const sp = toScreen(hn.x, hn.y - Math.max(10, hn.r));
    showNotePopoverForNode(hn, sp);
  } else {
    hideNotePopover();
  }
});

// REPLACE existing pickNode(...) with this improved version
function pickNode(px, py){
  // px/py are CSS pixels (already what we pass from mouse events)
  const w = toWorld(px, py);

  // make feature nodes easier to hit: add a small screen-space padding (in pixels)
  // converted to world-space so it scales with zoom.
  const screenPadding = 8; // increase if you want even easier selection
  const worldPadding = screenPadding / Math.max(0.0001, world.camera.scale);

  // 1) Check features first (top-most features should be selectable even when inside group rect).
  // Iterate from topmost (end -> start) so nodes rendered later win.
  for (let i = world.nodes.length - 1; i >= 0; i--) {
    const n = world.nodes[i];
    if (!n || n.visible === false) continue;
    if (n.type !== 'feature') continue;
    const dx = w.x - n.x, dy = w.y - n.y;
    const d = Math.hypot(dx, dy);
    if (d <= (n.r + worldPadding)) return n;
  }

  // 2) Then check groups using their bounding box (rectangle)
  // (iterate from topmost as well).
  for (let i = world.nodes.length - 1; i >= 0; i--) {
    const n = world.nodes[i];
    if (!n || n.visible === false) continue;
    if (n.type !== 'group') continue;
    if (w.x >= n.x - n.r && w.x <= n.x + n.r && w.y >= n.y - n.r && w.y <= n.y + n.r) return n;
  }

  return null;
}


canvas.addEventListener('mousedown',(e)=>{
  mouse.x = e.offsetX; mouse.y = e.offsetY;
  const n = pickNode(mouse.x, mouse.y);

  // Right-click: start edge creation (unchanged)
  if (e.button === 2) {
    if (n) { creatingEdgeFrom = n.id; }
    return;
  }

  // Helper: treat Cmd (mac) same as Ctrl
  const multiKey = e.ctrlKey || e.metaKey;

  if (n) {
    // MULTI-SELECT TOGGLE (Ctrl/Cmd + click)
    if (multiKey) {
      // toggle membership
      if (selectedNodes.has(n.id)) selectedNodes.delete(n.id);
      else selectedNodes.add(n.id);

      // set primary selection to the last-clicked node so sidebar highlight behaves the same
      selectedNodeId = n.id;
      selectedGroupId = (n.type === 'feature') ? n.groupId : n.id;
      highlightInSidebar(n.id);

      // prepare dragging of the whole selection
      dragSelection = Array.from(selectedNodes)
        .map(id => world.nodes.find(x => x.id === id))
        .filter(Boolean);

      dragStartPositions = {};
      for (const nd of dragSelection) dragStartPositions[nd.id] = { x: nd.x, y: nd.y };
      dragOriginW = toWorld(mouse.x, mouse.y);

      // resizing only supported for single-node selection (Shift+drag)
      isResizing = e.shiftKey && dragSelection.length === 1;
      dragNode = (isResizing && dragSelection.length === 1) ? dragSelection[0] : null;

      // record undo for the user action
      pushUndo();
    }
    // NORMAL single-select & drag
    else {
      // replace selection with this node
      selectedNodes.clear();
      selectedNodes.add(n.id);
      selectedNodeId = n.id;
      selectedGroupId = (n.type === 'feature') ? n.groupId : n.id;
      highlightInSidebar(n.id);

      pushUndo();

      // start single-node drag or resize
      dragSelection = null;
      if (e.shiftKey) {
        isResizing = true;
        dragNode = n;
      } else {
        isResizing = false;
        dragNode = n;
        const w = toWorld(mouse.x, mouse.y);
        dragOffset.x = n.x - w.x;
        dragOffset.y = n.y - w.y;
      }
    }
  }
  // click on empty space -> start panning (and clear selection unless multiKey held)
  else {
    if (!multiKey) {
      selectedNodes.clear();
      selectedNodeId = null;
      selectedGroupId = null;
      refreshUI();
    }
    isPanning = true;
    panStart.x = mouse.x; panStart.y = mouse.y;
    camStart = {...world.camera};
  }
});


canvas.addEventListener('mouseup',(e)=>{
  // Right-button release edge creation
  if (e.button === 2) {
    const n = pickNode(mouse.x, mouse.y);
    if (creatingEdgeFrom && n && n.id !== creatingEdgeFrom) {
      pushUndo();
      world.edges.push({ id: uid(), aId: creatingEdgeFrom, bId: n.id, visible:true, label:'', imageDataUrl:null, imageSize:120 });
      refreshUI();
    }
    creatingEdgeFrom = null;
    hoverNodeId = pickNode(mouse.x, mouse.y)?.id || null;
    return;
  }

  // End any drag of selection or single node
  dragSelection = null;
  dragStartPositions = null;
  dragOriginW = null;
  dragNode = null;
  isResizing = false;
  isPanning = false;

  // recompute hover quickly to avoid stuck highlight
  hoverNodeId = pickNode(mouse.x, mouse.y)?.id || null;
});

// Clear hover & hide note popover if mouse leaves the canvas
canvas.addEventListener('mouseleave', () => {
  hoverNodeId = null;
  hideNotePopover && hideNotePopover(); // call if the function exists
});


canvas.addEventListener('dblclick',(e)=>{
  const w=toWorld(e.offsetX, e.offsetY); let nearest=null; let bestD = 12 / world.camera.scale;
  for(const ed of world.edges){ if(ed.visible===false) continue; const a = world.nodes.find(n=>n.id===ed.aId), b = world.nodes.find(n=>n.id===ed.bId); if(!a||!b||a.visible===false||b.visible===false) continue; const d=pointToSegmentDistance(w.x,w.y,a.x,a.y,b.x,b.y); if(d<bestD){ bestD=d; nearest=ed; } }
  if(nearest) openEdgeModal(nearest);
});

canvas.addEventListener('contextmenu',(e)=> e.preventDefault());

canvas.addEventListener('wheel',(e)=>{ e.preventDefault(); const delta = Math.sign(e.deltaY)*0.1; const oldScale = world.camera.scale; const newScale = clamp(oldScale*(1-delta), 0.25, 3.5); const mouseWBefore = toWorld(e.offsetX, e.offsetY); world.camera.scale = newScale; const mouseWAfter = toWorld(e.offsetX, e.offsetY); world.camera.x += (mouseWBefore.x - mouseWAfter.x); world.camera.y += (mouseWBefore.y - mouseWAfter.y); },{passive:false});

// clicking a node: center + toggle all its connections visible state (fixed behavior)
// Improved click handler: toggles selection if clicked again, uses fresh event coords,
// toggles edges explicitly, and recomputes hover after click to avoid stale highlight.
canvas.addEventListener('click', (e) => {
  if (e.button !== 0) return;
  // If multi-select modifier is pressed, do nothing here.
  // (Ctrl/Cmd+click is handled on mousedown to toggle selection)
  const multiKey = e.ctrlKey || e.metaKey;
  if (multiKey) return;
  // Use event coordinates (fresh) for picking — avoid any stale mouse.x
  const n = pickNode(e.offsetX, e.offsetY);
  if (!n) {
    // click on empty canvas: clear selection
    selectedNodeId = null;
    selectedGroupId = null;
    refreshUI();
    hoverNodeId = pickNode(e.offsetX, e.offsetY)?.id || null;
    return;
  }

  // center smoothly
  flyTo(n, { scale: Math.max(0.9, world.camera.scale) });

  // If user clicked the same node that is already selected -> toggle it off
  if (selectedNodeId === n.id) {
    selectedNodeId = null;
    selectedGroupId = null;
    // still toggle edges for the node (explicit boolean toggle)
    pushUndo();
    for (const ed of world.edges) {
      if (ed.aId === n.id || ed.bId === n.id) ed.visible = !ed.visible;
    }
    // recompute hover immediately
    hoverNodeId = pickNode(e.offsetX, e.offsetY)?.id || null;
    refreshUI();
    return;
  }

  // Otherwise select the new node
  pushUndo();
  // toggle edges for that node explicitly (boolean toggle)
  for (const ed of world.edges) {
    if (ed.aId === n.id || ed.bId === n.id) ed.visible = !ed.visible;
  }

  // highlight in sidebar and mark selected
  highlightInSidebar(n.id);
  // ensure selectedNodeId is set (highlightInSidebar sets it, but keep explicit)
  selectedNodeId = n.id;

  // recompute hover using event coords so draw uses consistent state
  hoverNodeId = pickNode(e.offsetX, e.offsetY)?.id || null;

  refreshUI();
});


// edge modal logic (simple implementation)
const edgeModal = document.getElementById('edge-modal');
const edgeLabel = document.getElementById('edge-label');
const edgeImageUrl = document.getElementById('edge-image-url');
const edgeFile = document.getElementById('edge-image-file');
const edgeSize = document.getElementById('edge-image-size');
const edgeSave = document.getElementById('edge-save');
const edgeCancel = document.getElementById('edge-cancel');
const edgeClear = document.getElementById('edge-clear');
let modalEdge = null;
function openEdgeModal(edge){ modalEdge = edge; edgeLabel.value = edge.label || ''; edgeImageUrl.value = (edge.imageDataUrl && !edge.imageDataUrl.startsWith('data:'))?edge.imageDataUrl:''; edgeSize.value = edge.imageSize || 120; edgeModal.classList.remove('hidden'); }
edgeSave.onclick = ()=>{ if(!modalEdge) return; pushUndo(); modalEdge.label = edgeLabel.value; const url = edgeImageUrl.value.trim(); if(url) modalEdge.imageDataUrl = url; modalEdge.imageSize = +edgeSize.value; edgeModal.classList.add('hidden'); modalEdge=null; }
edgeCancel.onclick = ()=>{ edgeModal.classList.add('hidden'); modalEdge=null; }
edgeClear.onclick = ()=>{ if(!modalEdge) return; pushUndo(); modalEdge.imageDataUrl = null; edgeModal.classList.add('hidden'); modalEdge=null; }
edgeFile.onchange = (e)=>{ const f = e.target.files[0]; if(!f || !modalEdge) return; const fr = new FileReader(); fr.onload = ()=>{ edgeImageUrl.value=''; modalEdge.imageDataUrl = fr.result; }; fr.readAsDataURL(f); }

// toggle all edges button
document.getElementById('toggle-all-edges').onclick = ()=>{ pushUndo(); const anyVisible = world.edges.some(e=>e.visible!==false); for(const e of world.edges) e.visible = !anyVisible; refreshUI(); }

// export image & state & import handlers
document.getElementById('export-image').onclick = ()=>{ const exportCanvas = document.createElement('canvas'); exportCanvas.width = canvas.width; exportCanvas.height = canvas.height; const ex = exportCanvas.getContext('2d'); ex.fillStyle='#0f1225'; ex.fillRect(0,0,exportCanvas.width,exportCanvas.height); ex.drawImage(canvas,0,0); const link=document.createElement('a'); link.download='canvas.png'; link.href = exportCanvas.toDataURL('image/png'); link.click(); }
document.getElementById('export-state').onclick = ()=>{ const blob = new Blob([JSON.stringify(world)], {type:'application/json'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='state.json'; a.click(); URL.revokeObjectURL(url); }
document.getElementById('import-state').addEventListener('change',(e)=>{ const f=e.target.files[0]; if(!f) return; const fr=new FileReader(); fr.onload = ()=>{ try{ pushUndo(); world = JSON.parse(fr.result); refreshUI(); }catch(err){ alert('Invalid state JSON'); } }; fr.readAsText(f); });
document.getElementById('import-source').addEventListener('change',(e)=>{ const f=e.target.files[0]; if(!f) return; const fr=new FileReader(); fr.onload = ()=>{ try{ const src = JSON.parse(fr.result); pushUndo(); buildFromSource(src); refreshUI(); }catch(err){ alert('Invalid source JSON'); } }; fr.readAsText(f); });

// Add group/feature handlers
document.getElementById('add-group').addEventListener('click', ()=>{ const name=document.getElementById('new-group-name').value.trim(); if(!name) return; pushUndo(); const id=uid(); const pos=randomPointInRing(200,600); const color=colorFor(world.meta.nextGroupIx++); world.nodes.push({ id, type:'group', name, x:pos.x, y:pos.y, r:50, color, visible:true, note:null }); document.getElementById('new-group-name').value=''; refreshUI(); });
document.getElementById('add-feature').addEventListener('click', ()=>{ const groupId=document.getElementById('feature-group').value; const name=document.getElementById('new-feature-name').value.trim(); if(!groupId||!name) return; pushUndo(); const g = world.nodes.find(n=>n.id===groupId); const id=uid(); const rp=randomPointInRing(40,100); world.nodes.push({ id, type:'feature', groupId, name, x:g.x+rp.x*0.25, y:g.y+rp.y*0.25, r:18, color:g.color, visible:true, note:null }); document.getElementById('new-feature-name').value=''; refreshUI(); });

// show note toggles
document.getElementById('show-notes-toggle').addEventListener('change', (e)=>{ world.settings.showNotes = e.target.checked; if(!e.target.checked) hideNotePopover(); });
document.getElementById('show-note-indicators').addEventListener('change', (e)=>{ world.settings.showIndicators = e.target.checked; refreshUI(); });



// build from source
function buildFromSource(src){ world = { nodes:[], edges:[], camera:{x:0,y:0,scale:1}, meta:{ nextGroupIx:0 }, settings: world.settings || { showNotes:true, showIndicators:true } }; const entries = Object.entries(src); entries.sort((a,b)=>a[0].localeCompare(b[0])); let gix=0; for(const [file, cols] of entries){ const gid=uid(); const pos=randomPointInRing(200,700); const color=colorFor(gix++); world.nodes.push({ id:gid, type:'group', name:file, x:pos.x, y:pos.y, r:50, color, visible:true, note:null }); if(Array.isArray(cols)) for(const c of cols){ const fid=uid(); const rp=randomPointInRing(10,90); world.nodes.push({ id:fid, type:'feature', groupId:gid, name:c, x:pos.x+rp.x*0.3, y:pos.y+rp.y*0.3, r:16, color, visible:true, note:null }); } } refreshUI(); }

// initial sample
buildFromSource({"Getting Started":[]});

function refreshUI(){ rebuildVisibilityTree(); if(selectedNodeId) highlightInSidebar(selectedNodeId); else if(selectedGroupId) highlightInSidebar(selectedGroupId); }

// initialize animation
let last = performance.now(); function tick(t){ const dt=(t-last)/16.67; last=t; physicsTick(dt); ctx.clearRect(0,0,canvas.width,canvas.height); draw(); requestAnimationFrame(tick); } requestAnimationFrame(tick);

// helper for note popover placement already uses toScreen etc.

// center on sidebar click
function onSidebarItemClick(nodeId){ const n = world.nodes.find(x=>x.id===nodeId); if(n){ flyTo(n, { scale: Math.max(0.85, world.camera.scale) }); highlightInSidebar(nodeId); refreshUI(); } }

// expose undo/redo via keys already
// End of app.js
