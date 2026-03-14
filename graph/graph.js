// graph.js — Ultra 3D Neuron Memory Network
// Dual-canvas: bg (stars/nebula) + fg (3D graph with energy particles)

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
const bgC    = document.getElementById('bg-canvas');
const bgCtx  = bgC.getContext('2d');

// ─── Category palette ─────────────────────────────────────────────────────────

const CAT_COLORS = {
  'Music':         '#ff6b9d',
  'Educational':   '#4e9fff',
  'Entertainment': '#f5a623',
  'Comedy':        '#ffe066',
  'Gaming':        '#4ecc91',
  'News':          '#cc4eff',
  'Sports':        '#ff8c4e',
  'Other':         '#666666',
};

// Convert any hex color to rgba for safe alpha blending
function hexAlpha(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  const r = parseInt(full.slice(0,2), 16);
  const g = parseInt(full.slice(2,4), 16);
  const b = parseInt(full.slice(4,6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ─── State ────────────────────────────────────────────────────────────────────

let nodes    = [];
let edges    = [];
let nodeMap  = {};
let stars    = [];
let particles = []; // energy pulse particles on edges

let rotX = 0.22, rotY = 0;
let autoRotate = true;
let zoom = 1;
let time = 0;

let isDragging = false, dragMoved = false;
let lastMX = 0, lastMY = 0;
let hoveredNode = null;
let selectedNode = null;

let frameCount = 0;
let dataReady  = false;

// Physics
const REPULSION    = 10000;
const SPRING_K     = 0.022;
const CENTER_K     = 0.016;
const DAMPING      = 0.83;
const ORBIT_RADIUS = 280;
const MIN_DIST     = 35;

// Projection
const FOV      = 700;
const CAMERA_Z = 950;

// ─── Stars background ────────────────────────────────────────────────────────

function initStars() {
  stars = [];
  const count = Math.floor(window.innerWidth * window.innerHeight / 1800);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random() * 0.5 + 0.1,
      speed: Math.random() * 0.3 + 0.1,
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function drawBg() {
  const W = window.innerWidth, H = window.innerHeight;
  const dpr = devicePixelRatio || 1;
  bgCtx.clearRect(0, 0, W * dpr, H * dpr);
  bgCtx.save();
  bgCtx.scale(dpr, dpr);

  // Deep space gradient
  const bg = bgCtx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.75);
  bg.addColorStop(0, '#080818');
  bg.addColorStop(0.5, '#050510');
  bg.addColorStop(1, '#020206');
  bgCtx.fillStyle = bg;
  bgCtx.fillRect(0, 0, W, H);

  // Nebula blobs
  const t = time * 0.0003;
  const drawNebula = (cx, cy, radius, color) => {
    const ng = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    ng.addColorStop(0, hexAlpha(color, 0.04));
    ng.addColorStop(0.5, hexAlpha(color, 0.016));
    ng.addColorStop(1, hexAlpha(color, 0));
    bgCtx.fillStyle = ng;
    bgCtx.beginPath();
    bgCtx.arc(cx, cy, radius, 0, Math.PI * 2);
    bgCtx.fill();
  };
  drawNebula(W * 0.3 + Math.sin(t) * 40, H * 0.3 + Math.cos(t * 0.7) * 30, W * 0.4, '#4e6fff');
  drawNebula(W * 0.7 + Math.cos(t * 0.8) * 50, H * 0.6 + Math.sin(t * 0.5) * 40, W * 0.35, '#6b4eff');
  drawNebula(W * 0.5 + Math.sin(t * 0.6) * 30, H * 0.8, W * 0.3, '#4e9fff');

  // Stars with twinkling
  for (const s of stars) {
    const twinkle = Math.sin(time * 0.002 * s.speed + s.phase);
    const alpha = s.a * (0.6 + twinkle * 0.4);
    bgCtx.save();
    bgCtx.globalAlpha = Math.max(0, alpha);
    bgCtx.fillStyle = '#fff';
    bgCtx.beginPath();
    bgCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    bgCtx.fill();

    // Larger stars get a tiny cross flare
    if (s.r > 1) {
      bgCtx.globalAlpha = alpha * 0.3;
      bgCtx.strokeStyle = '#fff';
      bgCtx.lineWidth = 0.5;
      const len = s.r * 3;
      bgCtx.beginPath();
      bgCtx.moveTo(s.x - len, s.y); bgCtx.lineTo(s.x + len, s.y);
      bgCtx.moveTo(s.x, s.y - len); bgCtx.lineTo(s.x, s.y + len);
      bgCtx.stroke();
    }
    bgCtx.restore();
  }

  bgCtx.restore();
}

// ─── Energy particles on edges ────────────────────────────────────────────────

function spawnParticles() {
  // Keep ~2 particles per edge, recycle
  const target = edges.length * 2 + nodes.length; // also center→node
  while (particles.length < Math.min(target, 300)) {
    const useEdge = Math.random() < 0.6 && edges.length > 0;
    if (useEdge) {
      const e = edges[Math.floor(Math.random() * edges.length)];
      particles.push({
        type: 'edge',
        source: e.source,
        target: e.target,
        t: Math.random(),
        speed: 0.002 + Math.random() * 0.004,
        size: 1 + e.weight * 2,
        color: nodeMap[e.source]?.color || '#4e9fff',
      });
    } else {
      // Center → random node
      const memNodes = nodes.filter(n => !n.isCenter);
      if (!memNodes.length) break;
      const n = memNodes[Math.floor(Math.random() * memNodes.length)];
      particles.push({
        type: 'axon',
        target: n.id,
        t: Math.random(),
        speed: 0.001 + Math.random() * 0.002,
        size: 0.8 + Math.random() * 0.8,
        color: '#4e9fff',
      });
    }
  }
}

function tickParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += p.speed;
    if (p.t > 1) {
      p.t -= 1; // loop
    }
  }
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function resize() {
  const dpr = devicePixelRatio || 1;
  for (const c of [canvas, bgC]) {
    c.width  = window.innerWidth  * dpr;
    c.height = window.innerHeight * dpr;
    c.style.width  = window.innerWidth  + 'px';
    c.style.height = window.innerHeight + 'px';
  }
  initStars();
}
window.addEventListener('resize', resize);

// ─── Projection ───────────────────────────────────────────────────────────────

function project(x, y, z) {
  const cY = Math.cos(rotY), sY = Math.sin(rotY);
  const x1 =  x * cY + z * sY;
  const z1 = -x * sY + z * cY;
  const cX = Math.cos(rotX), sX = Math.sin(rotX);
  const y2 =  y * cX - z1 * sX;
  const z2 =  y * sX + z1 * cX;
  const dz = Math.max(CAMERA_Z + z2, 1);
  const scale = FOV / dz * zoom;
  return {
    sx: window.innerWidth / 2 + x1 * scale,
    sy: window.innerHeight / 2 + y2 * scale,
    scale,
    depth: z2,
  };
}

// ─── Load data ────────────────────────────────────────────────────────────────

async function loadData() {
  console.log('[Graph] loadData() starting...');
  const debugEl = document.getElementById('loading');

  try {
    // Use direct callback like the library page does (proven to work)
    const grouped = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_LIBRARY' }, (resp) => {
        void chrome.runtime.lastError;
        console.log('[Graph] GET_LIBRARY raw response:', resp, typeof resp);
        resolve(resp);
      });
    });

    if (!grouped || typeof grouped !== 'object') {
      console.warn('[Graph] No grouped data, got:', grouped);
      showEmpty();
      return;
    }

    const allVideos = Object.values(grouped).flat();
    console.log('[Graph] Total videos:', allVideos.length);

    if (!allVideos.length) {
      showEmpty();
      return;
    }

    // Center "You" node
    const center = {
      id: '__user__', title: 'You', channelName: '', category: '__center__',
      totalWatched: 0, keywords: [], entities: [], url: null,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: 0,
      r: 55, color: '#ffffff', isCenter: true, fixed: true,
    };

    const N = allVideos.length;
    const memNodes = allVideos.map((v, i) => {
      const phi   = Math.acos(1 - 2 * (i + 0.5) / N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const spread = ORBIT_RADIUS * (0.7 + Math.random() * 0.6);
      const r = 6 + Math.sqrt(Math.min(v.totalWatched || 10, 3600)) * 0.7;
      return {
        id: v.videoId, title: v.title || 'Untitled',
        channelName: v.channelName || '', category: v.category || 'Other',
        totalWatched: v.totalWatched || 0, keywords: v.keywords || [],
        entities: v.entities || [], url: v.url,
        x: spread * Math.sin(phi) * Math.cos(theta),
        y: spread * Math.sin(phi) * Math.sin(theta),
        z: spread * Math.cos(phi),
        vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: 0,
        r, color: CAT_COLORS[v.category] || CAT_COLORS['Other'],
        isCenter: false, fixed: false,
      };
    });

    nodes   = [center, ...memNodes];
    nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;

    // Fetch edges
    const edgePromises = memNodes.map(n =>
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_EDGES', videoId: n.id }, r => {
          void chrome.runtime.lastError;
          resolve(r || []);
        });
      })
    );
    const lists = await Promise.all(edgePromises);
    const eMap = {};
    for (const l of lists) for (const e of l) if (!eMap[e.id]) eMap[e.id] = e;
    edges = Object.values(eMap).filter(e => e.weight > 0.2);
    console.log('[Graph] Edges loaded:', edges.length);

    // Animate stat counters
    animateCounter('stat-nodes', memNodes.length);
    animateCounter('stat-edges', edges.length);

    // Legend
    buildLegend([...new Set(memNodes.map(n => n.category))]);

    // Particles
    spawnParticles();

    // Hide loader
    debugEl.classList.add('hide');

    dataReady = true;
    console.log('[Graph] Starting render loop with', nodes.length, 'nodes');
    startLoop();

  } catch (err) {
    console.error('[Graph] loadData() CRASHED:', err);
    // Show the error on screen so user can see it
    const loadingText = document.querySelector('.loader-text');
    if (loadingText) loadingText.textContent = 'Error: ' + err.message;
    setTimeout(() => showEmpty(), 2000);
  }
}

function showEmpty() {
  document.getElementById('loading').classList.add('hide');
  document.getElementById('empty').classList.add('show');
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  let current = 0;
  const step = Math.max(1, Math.floor(target / 30));
  const iv = setInterval(() => {
    current = Math.min(current + step, target);
    el.textContent = current;
    if (current >= target) clearInterval(iv);
  }, 25);
}

// ─── Force simulation (3D) ────────────────────────────────────────────────────

function tick() {
  const mem = nodes.filter(n => !n.fixed);
  const center = nodeMap['__user__'];
  for (const n of mem) { n.fx = 0; n.fy = 0; n.fz = 0; }

  // Repulsion
  for (let i = 0; i < mem.length; i++) {
    for (let j = i + 1; j < mem.length; j++) {
      const a = mem[i], b = mem[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      let dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      if (dist < MIN_DIST) dist = MIN_DIST;
      const f = REPULSION / (dist * dist);
      const inv = 1 / dist;
      a.fx -= dx*inv*f; a.fy -= dy*inv*f; a.fz -= dz*inv*f;
      b.fx += dx*inv*f; b.fy += dy*inv*f; b.fz += dz*inv*f;
    }
  }

  // Orbit shell pull
  for (const n of mem) {
    const dx = center.x - n.x, dy = center.y - n.y, dz = center.z - n.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    const f = CENTER_K * (dist - (ORBIT_RADIUS + n.r));
    const inv = 1 / dist;
    n.fx += dx*inv*f; n.fy += dy*inv*f; n.fz += dz*inv*f;
  }

  // Edge springs
  for (const e of edges) {
    const a = nodeMap[e.source], b = nodeMap[e.target];
    if (!a || !b || a.fixed || b.fixed) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    const nat = 200 * (1 - e.weight * 0.4);
    const f = SPRING_K * (dist - nat) * e.weight;
    const inv = 1 / dist;
    a.fx += dx*inv*f; a.fy += dy*inv*f; a.fz += dz*inv*f;
    b.fx -= dx*inv*f; b.fy -= dy*inv*f; b.fz -= dz*inv*f;
  }

  // Integrate
  for (const n of mem) {
    n.vx = (n.vx + n.fx) * DAMPING;
    n.vy = (n.vy + n.fy) * DAMPING;
    n.vz = (n.vz + n.fz) * DAMPING;
    n.x += n.vx; n.y += n.vy; n.z += n.vz;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function draw() {
  const W = window.innerWidth, H = window.innerHeight;
  const dpr = devicePixelRatio || 1;
  ctx.clearRect(0, 0, W * dpr, H * dpr);
  ctx.save();
  ctx.scale(dpr, dpr);

  const proj = nodes.map(n => ({ node: n, ...project(n.x, n.y, n.z) }));
  const pMap = {};
  for (const p of proj) pMap[p.node.id] = p;

  const maxD = 550;
  const df = d => Math.max(0.1, Math.min(1, 1 - (d + maxD) / (maxD * 2.6)));

  const centerP = pMap['__user__'];
  const isHovering = !!hoveredNode;
  const isSelected = !!selectedNode;

  // ── Axon lines: center → each memory ───────────────────────────────────
  for (const p of proj) {
    if (p.node.isCenter) continue;
    const fade = df(p.depth);
    const isConn = hoveredNode && hoveredNode.id === p.node.id;

    ctx.save();
    ctx.globalAlpha = isConn ? 0.25 : (isHovering ? 0.03 : 0.055 + fade * 0.04);

    const grad = ctx.createLinearGradient(centerP.sx, centerP.sy, p.sx, p.sy);
    grad.addColorStop(0, '#4e9fff');
    grad.addColorStop(1, hexAlpha(p.node.color, 0.27));
    ctx.strokeStyle = grad;
    ctx.lineWidth = isConn ? 1.2 : 0.5;
    ctx.beginPath();
    ctx.moveTo(centerP.sx, centerP.sy);
    ctx.lineTo(p.sx, p.sy);
    ctx.stroke();
    ctx.restore();
  }

  // ── Memory-to-memory synaptic edges ─────────────────────────────────────
  for (const e of edges) {
    const pa = pMap[e.source], pb = pMap[e.target];
    if (!pa || !pb) continue;
    const avgD = (pa.depth + pb.depth) / 2;
    const fade = df(avgD);
    const isLit = hoveredNode &&
      (hoveredNode.id === e.source || hoveredNode.id === e.target);
    const isSel = selectedNode &&
      (selectedNode.id === e.source || selectedNode.id === e.target);

    ctx.save();
    ctx.globalAlpha = isLit || isSel
      ? Math.min(e.weight * 0.6 + 0.45, 1)
      : (isHovering ? 0.02 : (e.weight * 0.2 + 0.03) * (0.3 + fade * 0.7));
    ctx.lineWidth = isLit || isSel ? e.weight * 3.5 + 1.5 : e.weight * 1.5 + 0.3;

    const grad = ctx.createLinearGradient(pa.sx, pa.sy, pb.sx, pb.sy);
    grad.addColorStop(0, pa.node.color);
    grad.addColorStop(1, pb.node.color);
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(pa.sx, pa.sy);
    ctx.lineTo(pb.sx, pb.sy);
    ctx.stroke();
    ctx.restore();
  }

  // ── Energy particles ────────────────────────────────────────────────────
  for (const p of particles) {
    let sx, sy, alpha;
    if (p.type === 'edge') {
      const a = pMap[p.source], b = pMap[p.target];
      if (!a || !b) continue;
      sx = a.sx + (b.sx - a.sx) * p.t;
      sy = a.sy + (b.sy - a.sy) * p.t;
      const avgDepth = a.depth + (b.depth - a.depth) * p.t;
      alpha = df(avgDepth) * 0.6;
    } else {
      const cp = centerP;
      const tp = pMap[p.target];
      if (!tp) continue;
      sx = cp.sx + (tp.sx - cp.sx) * p.t;
      sy = cp.sy + (tp.sy - cp.sy) * p.t;
      const avgDepth = cp.depth + (tp.depth - cp.depth) * p.t;
      alpha = df(avgDepth) * 0.35;
    }

    // Fade near endpoints
    const tFade = Math.min(p.t, 1 - p.t) * 4;
    alpha *= Math.min(1, tFade);

    if (alpha < 0.02) continue;

    const pg = ctx.createRadialGradient(sx, sy, 0, sx, sy, p.size * 3);
    pg.addColorStop(0, hexAlpha(p.color, 0.8));
    pg.addColorStop(0.5, hexAlpha(p.color, 0.27));
    pg.addColorStop(1, hexAlpha(p.color, 0));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, p.size * 3, 0, Math.PI * 2);
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.restore();
  }

  // ── Nodes (depth sorted, center always on top) ──────────────────────────
  const sorted = [...proj].filter(p => !p.node.isCenter).sort((a, b) => b.depth - a.depth);
  const centerProj = proj.find(p => p.node.isCenter);
  if (centerProj) sorted.push(centerProj); // center drawn last = always on top

  for (const p of sorted) {
    const n  = p.node;
    const r  = Math.max(n.isCenter ? 34 : 3, n.r * p.scale);
    const fade = df(p.depth);
    const isHov = hoveredNode && hoveredNode.id === n.id;
    const isSel = selectedNode && selectedNode.id === n.id;
    const isDim = isHovering && !isHov && !n.isCenter &&
      !edges.some(e =>
        (e.source === hoveredNode.id && e.target === n.id) ||
        (e.target === hoveredNode.id && e.source === n.id)
      );

    const nodeAlpha = n.isCenter ? 1 : (isDim ? 0.12 : (0.4 + fade * 0.6));

    // Center node pulsing rings
    if (n.isCenter) {
      const pulse = Math.sin(time * 0.002) * 0.3 + 0.7;
      for (let ring = 1; ring <= 4; ring++) {
        const rr = r + ring * 20 + Math.sin(time * 0.0015 + ring) * 8;
        ctx.save();
        ctx.globalAlpha = (0.12 - ring * 0.025) * pulse;
        ctx.strokeStyle = '#4e9fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Outer glow
    const glowR = r * (n.isCenter ? 4.5 : isHov ? 4 : 2.5);
    const gc = n.isCenter ? '#4e9fff' : n.color;
    const aura = ctx.createRadialGradient(p.sx, p.sy, r * 0.3, p.sx, p.sy, glowR);
    aura.addColorStop(0, hexAlpha(gc, isHov || n.isCenter ? 0.2 : 0.09));
    aura.addColorStop(0.6, hexAlpha(gc, 0.03));
    aura.addColorStop(1, hexAlpha(gc, 0));
    ctx.save();
    ctx.globalAlpha = n.isCenter ? 1 : nodeAlpha;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = aura;
    ctx.fill();
    ctx.restore();

    // Connected highlight ring
    if (hoveredNode && !n.isCenter && hoveredNode.id !== n.id) {
      const conn = edges.some(e =>
        (e.source === hoveredNode.id && e.target === n.id) ||
        (e.target === hoveredNode.id && e.source === n.id)
      );
      if (conn) {
        ctx.save();
        ctx.globalAlpha = fade * 0.55;
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -time * 0.02;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Sphere body
    const bodyGrad = ctx.createRadialGradient(
      p.sx - r * 0.3, p.sy - r * 0.3, r * 0.05, p.sx, p.sy, r
    );
    if (n.isCenter) {
      bodyGrad.addColorStop(0,   '#ffffff');
      bodyGrad.addColorStop(0.3, '#d0e8ff');
      bodyGrad.addColorStop(0.7, '#4e9fff');
      bodyGrad.addColorStop(1,   '#1a4fff');
    } else {
      bodyGrad.addColorStop(0, lighten(n.color, 100));
      bodyGrad.addColorStop(0.4, n.color);
      bodyGrad.addColorStop(1, darken(n.color, 80));
    }

    ctx.save();
    ctx.globalAlpha = nodeAlpha;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Border
    if (isHov || isSel) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.shadowColor = n.color;
      ctx.shadowBlur = 12;
    } else {
      ctx.strokeStyle = hexAlpha(gc, 0.4);
      ctx.lineWidth = 0.6;
    }
    ctx.stroke();
    ctx.restore();

    // Specular highlight
    if (r > 5) {
      const hR = r * 0.3;
      const hx = p.sx - r * 0.28, hy = p.sy - r * 0.3;
      const hGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, hR);
      hGrad.addColorStop(0, 'rgba(255,255,255,0.7)');
      hGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      ctx.globalAlpha = nodeAlpha * 0.85;
      ctx.beginPath();
      ctx.arc(hx, hy, hR, 0, Math.PI * 2);
      ctx.fillStyle = hGrad;
      ctx.fill();
      ctx.restore();
    }

    // Label
    const showLabel = n.isCenter || isHov || isSel || (p.scale > 0.65 && r > 11);
    if (showLabel) {
      const maxLen = n.isCenter ? 3 : 22;
      const label = n.title.length > maxLen ? n.title.slice(0, maxLen) + '...' : n.title;
      const fs = n.isCenter
        ? Math.max(15, Math.min(22, r * 0.5))
        : Math.max(8, Math.min(11, r * 0.6));

      ctx.save();
      ctx.globalAlpha = nodeAlpha * (isHov ? 1 : 0.7);
      ctx.font = `${n.isCenter || isHov || isSel ? 700 : 500} ${fs}px Inter, -apple-system, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = n.isCenter ? 'middle' : 'top';
      ctx.shadowColor = 'rgba(0,0,0,1)';
      ctx.shadowBlur = 8;
      ctx.fillText(label, p.sx, n.isCenter ? p.sy : p.sy + r + 4);

      // Category label below title for non-center
      if (!n.isCenter && (isHov || isSel)) {
        ctx.font = `500 ${fs - 1}px Inter, sans-serif`;
        ctx.fillStyle = n.color;
        ctx.globalAlpha = nodeAlpha * 0.6;
        ctx.fillText(n.category, p.sx, p.sy + r + 4 + fs + 2);
      }
      ctx.restore();
    }
  }

  ctx.restore();
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function startLoop() {
  function loop() {
    time = performance.now();
    // No physics — nodes stay in their initial positions

    if (autoRotate && !isDragging) rotY += 0.0012;

    tickParticles();
    drawBg();
    draw();
    frameCount++;
    requestAnimationFrame(loop);
  }
  loop();
}

// ─── Hit test ─────────────────────────────────────────────────────────────────

function getNodeAt(mx, my) {
  // Check front-to-back (closer nodes first)
  const proj = nodes.map(n => ({ node: n, ...project(n.x, n.y, n.z) }));
  proj.sort((a, b) => a.depth - b.depth);

  for (const p of proj) {
    const r = Math.max(p.node.isCenter ? 20 : 3, p.node.r * p.scale);
    const dx = p.sx - mx, dy = p.sy - my;
    if (dx*dx + dy*dy <= (r + 6) * (r + 6)) return p.node;
  }
  return null;
}

// ─── Mouse ────────────────────────────────────────────────────────────────────

canvas.addEventListener('mousemove', (e) => {
  const mx = e.clientX, my = e.clientY;
  if (isDragging) {
    const dx = mx - lastMX, dy = my - lastMY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragMoved = true;
    rotY += dx * 0.004;
    rotX += dy * 0.004;
    rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, rotX));
    autoRotate = false;
    lastMX = mx; lastMY = my;
    return;
  }
  const node = getNodeAt(mx, my);
  hoveredNode = node;
  canvas.style.cursor = node ? 'pointer' : 'grab';
  if (node && !node.isCenter) showTooltip(node, mx, my);
  else hideTooltip();
});

canvas.addEventListener('mousedown', (e) => {
  isDragging = true; dragMoved = false;
  lastMX = e.clientX; lastMY = e.clientY;
  canvas.classList.add('dragging');
});

canvas.addEventListener('mouseup', (e) => {
  isDragging = false;
  canvas.classList.remove('dragging');
  if (!dragMoved) {
    const node = getNodeAt(e.clientX, e.clientY);
    if (node && !node.isCenter) {
      selectedNode = node;
      showInfoPanel(node);
    } else {
      selectedNode = null;
      hideInfoPanel();
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  isDragging = false; hoveredNode = null;
  hideTooltip(); canvas.classList.remove('dragging');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = Math.max(0.2, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
}, { passive: false });

// Touch
let lastTX = 0, lastTY = 0;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
    autoRotate = false;
  }
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) {
    rotY += (e.touches[0].clientX - lastTX) * 0.005;
    rotX += (e.touches[0].clientY - lastTY) * 0.005;
    rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, rotX));
    lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
  }
}, { passive: true });

// ─── Controls ─────────────────────────────────────────────────────────────────

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  zoom = Math.min(zoom * 1.3, 4);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  zoom = Math.max(zoom / 1.3, 0.2);
});
document.getElementById('btn-reset').addEventListener('click', () => {
  zoom = 1; rotX = 0.22; rotY = 0; autoRotate = true;
  selectedNode = null; hideInfoPanel();
});
document.getElementById('btn-library').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' }, () => void chrome.runtime.lastError);
});

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function showTooltip(node, mx, my) {
  const tt = document.getElementById('tooltip');
  tt.style.setProperty('--tt-color', node.color);
  document.getElementById('tooltip-title').textContent = node.title;
  document.getElementById('tooltip-channel').textContent = node.channelName;
  document.getElementById('tooltip-meta').innerHTML = `
    <div class="tooltip-stat">Watched <span>${fmtDur(node.totalWatched)}</span></div>
    <div class="tooltip-stat">Category <span>${node.category}</span></div>
  `;
  const concepts = [...(node.entities?.map(e => e.text) || []), ...(node.keywords || [])].slice(0, 5);
  document.getElementById('tooltip-keywords').innerHTML =
    concepts.map(k => `<span class="kw">${k}</span>`).join('');
  document.getElementById('tooltip-link').href = node.url || '#';

  const W = window.innerWidth, H = window.innerHeight;
  const left = mx + 20 + 260 > W ? mx - 270 : mx + 20;
  const top  = my + 14 + 200 > H ? my - 200 : my + 14;
  tt.style.left = left + 'px';
  tt.style.top  = top + 'px';
  tt.className = 'glass visible';
}

function hideTooltip() {
  const tt = document.getElementById('tooltip');
  tt.classList.remove('visible');
}

// ─── Info panel (click to inspect) ────────────────────────────────────────────

function showInfoPanel(node) {
  const panel = document.getElementById('info-panel');
  document.getElementById('info-title').textContent = node.title;
  document.getElementById('info-channel').textContent = node.channelName;
  document.getElementById('info-stats').innerHTML = `
    <div class="info-stat"><strong>${fmtDur(node.totalWatched)}</strong> watched</div>
    <div class="info-stat"><strong>${node.category}</strong></div>
  `;

  // Tags
  const entities = (node.entities || []).map(e =>
    `<span class="info-tag entity">${e.text}</span>`
  ).slice(0, 6);
  const kws = (node.keywords || []).map(k =>
    `<span class="info-tag">${k}</span>`
  ).slice(0, 6);
  document.getElementById('info-tags').innerHTML = [...entities, ...kws].join('');

  // Connections
  const conns = edges.filter(e => e.source === node.id || e.target === node.id)
    .sort((a, b) => b.weight - a.weight).slice(0, 5);
  const connHtml = conns.map(e => {
    const otherId = e.source === node.id ? e.target : e.source;
    const other = nodeMap[otherId];
    if (!other) return '';
    const pct = Math.round(e.weight * 100);
    return `
      <div class="info-conn">
        <div class="info-conn-bar"><div class="info-conn-bar-fill" style="width:${pct}%"></div></div>
        <div class="info-conn-name">${other.title}</div>
        <div class="info-conn-pct">${pct}%</div>
      </div>
    `;
  }).join('');
  document.getElementById('info-connections').innerHTML =
    connHtml || '<div style="font-size:11px;color:rgba(255,255,255,0.2)">No connections yet</div>';

  // Open button
  const openBtn = document.getElementById('info-open');
  openBtn.href = node.url || '#';

  panel.classList.add('visible');
}

function hideInfoPanel() {
  document.getElementById('info-panel').classList.remove('visible');
}

document.getElementById('info-panel-close').addEventListener('click', () => {
  selectedNode = null; hideInfoPanel();
});

// ─── Legend ───────────────────────────────────────────────────────────────────

function buildLegend(cats) {
  document.getElementById('legend').innerHTML = [
    `<div class="legend-item">
       <div class="legend-dot" style="background:#fff;box-shadow:0 0 8px #4e9fff66"></div>
       You
     </div>`,
    ...cats.map(cat => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${CAT_COLORS[cat] || '#666666'};box-shadow:0 0 6px ${hexAlpha(CAT_COLORS[cat] || '#666666', 0.27)}"></div>
        ${cat}
      </div>
    `),
  ].join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(h) {
  return { r: parseInt(h.slice(1,3),16), g: parseInt(h.slice(3,5),16), b: parseInt(h.slice(5,7),16) };
}
function lighten(h, a) { const c = hexToRgb(h); return `rgb(${Math.min(c.r+a,255)},${Math.min(c.g+a,255)},${Math.min(c.b+a,255)})`; }
function darken(h, a)  { const c = hexToRgb(h); return `rgb(${Math.max(c.r-a,0)},${Math.max(c.g-a,0)},${Math.max(c.b-a,0)})`; }
function fmtDur(s) {
  s = Math.round(s || 0);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

resize();
drawBg(); // show stars immediately while data loads
loadData();
