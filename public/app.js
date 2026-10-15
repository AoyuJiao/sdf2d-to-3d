/* =========================================================================
 * SDF 2D → 3D 转换器  (browser, RDKit WASM)
 * 引擎：官方 RDKit (MinimalLib) 自定义编译，新增 set_3d_coords (ETKDGv3 + MMFF94/UFF)
 * ======================================================================= */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- RDKit 初始化 ---------- */
let RDKit = null;
let rdkitReady = false;

function setRdkitStatus(cls, text){
  const el = $('rdkitStatus');
  el.className = 'badge ' + cls;
  el.textContent = text;
}

function initRDKit(){
  return new Promise((resolve, reject) => {
    if (typeof initRDKitModule !== 'function') {
      // 兼容 CJS 导出 (module.exports = Module)
      if (typeof Module !== 'undefined' && Module.get_mol) { RDKit = Module; return resolve(RDKit); }
      reject(new Error('RDKit_minimal.js 未加载'));
      return;
    }
    initRDKitModule().then(mod => { RDKit = mod; resolve(RDKit); })
                     .catch(reject);
  });
}

initRDKit().then(mod => {
  rdkitReady = true;
  const v = (mod.version ? mod.version() : '?');
  setRdkitStatus('ready', 'RDKit ' + v + ' 就绪');
  $('btnConvert').disabled = !$('input').value.trim();
}).catch(err => {
  setRdkitStatus('err', 'RDKit 加载失败');
  $('statusOut').className = 'status err';
  $('statusOut').textContent = 'RDKit WASM 加载失败：' + err.message +
    '\n请确认 /rdkit/RDKit_minimal.wasm 可用（首次加载约 5.5MB）。';
});

/* =========================================================================
 * SDF / MOL 解析（用于拆分记录、取标题、预览；化学由 RDKit 处理）
 * ======================================================================= */
function splitRecords(text){
  const norm = text.replace(/\r\n?/g, '\n');
  const blocks = norm.split(/^\$\$\$\$\s*$/m);
  const out = [];
  for (let b of blocks){
    b = b.replace(/^\n+/, '');
    if (b.trim()) out.push(b);
  }
  // 最后一块若无 $$$$，也作为记录
  return out;
}

function recTitle(block){
  const first = block.split('\n')[0] || '';
  return first.trim() || '(无标题)';
}

/* =========================================================================
 * 转换核心
 * ======================================================================= */
async function convertAll(){
  if (!rdkitReady){ return; }
  const text = $('input').value;
  const stIn = $('statusIn'), stOut = $('statusOut');
  if (!text.trim()){ stIn.className='status err'; stIn.textContent='输入为空。'; return; }

  const records = splitRecords(text);
  if (!records.length){ stIn.className='status err'; stIn.textContent='未解析到记录。'; return; }

  const ff = $('optFF').value;
  const seed = parseInt($('optSeed').value, 10);
  const addH = $('optEmbedH').checked;

  const params = {};
  if (isFinite(seed)) params.randomSeed = seed;
  params.forceField = ff;
  // ETKDGv3 参数
  const paramsJson = JSON.stringify(params);

  const outputs = [];
  const summary = [];
  let firstMol = null;

  $('btnConvert').disabled = true;
  $('btnConvert').textContent = '转换中…';

  // 逐条处理，让 UI 有机会刷新
  for (let i = 0; i < records.length; i++){
    const block = records[i];
    const title = recTitle(block);
    let mol = null;
    try {
      mol = RDKit.get_mol(block);
      if (!mol || !mol.is_valid()){
        summary.push(`#${i+1} ${title}: ✗ 无法解析`);
        continue;
      }
      const had3D = hasNonZeroZ(block);
      const rc = mol.set_3d_coords(paramsJson);
      if (rc === 0){
        summary.push(`#${i+1} ${title}: ✗ 3D 嵌入失败（可能是复杂立体化学/环）`);
        mol.delete(); mol = null;
        continue;
      }
      // 输出 molblock（RDKit 会标注 3D 并补氢）
      let mb = mol.get_molblock();
      mb = normalizeMolblock(mb, title);
      outputs.push(mb);
      const nA = mol.get_num_atoms();
      const nB = mol.get_num_bonds();
      summary.push(`#${i+1} ${title}: ✓ ${nA} 原子 / ${nB} 键` +
                   (had3D ? '（输入已含 3D，已重新嵌入）' : '') +
                   ` · 力场 ${ff === 'none' ? '无' : ff}`);
      if (!firstMol) firstMol = { molblock: mb, title };
    } catch(e){
      summary.push(`#${i+1} ${title}: ✗ ${e.message}`);
    } finally {
      if (mol) mol.delete();
    }
    await new Promise(r => setTimeout(r, 0)); // 让出主线程
  }

  const outText = outputs.join('');
  window.__lastSDF = outText;

  stIn.className = 'status ok';
  stIn.textContent = `解析到 ${records.length} 条记录。`;

  if (!outputs.length){
    stOut.className = 'status err';
    stOut.textContent = '转换失败：\n' + summary.join('\n');
  } else {
    stOut.className = 'status ok';
    stOut.textContent = `完成：${outputs.length}/${records.length} 条 → 3D。\n` + summary.join('\n');
  }

  $('btnCopy').disabled = !outputs.length;
  $('btnDownload').disabled = !outputs.length;
  $('btnConvert').disabled = false;
  $('btnConvert').textContent = '转换为 3D';

  if (firstMol){
    renderMolblock(firstMol.molblock);
    const n = countAtoms(firstMol.molblock);
    $('molInfo').textContent = `${firstMol.title} · ${n} 原子`;
  }
}

function hasNonZeroZ(block){
  const lines = block.split('\n');
  for (let i = 4; i < lines.length; i++){
    const l = lines[i];
    if (l.length < 30) continue;
    const z = parseFloat(l.slice(20, 30));
    if (isFinite(z) && Math.abs(z) > 1e-3) return true;
  }
  return false;
}

/* 规整 molblock：确保标题、程序行含 3D、计数从实际坐标行推导 */
function normalizeMolblock(mb, title){
  const lines = mb.replace(/\r\n?/g, '\n').split('\n');
  // RDKit 输出：line0 = title(可能空), line1 = 程序行含 3D, line2 = 注释, line3 = counts
  lines[0] = title || lines[0] || 'converted';
  // 确保程序行标 3D
  if (lines[1] && !/3D/.test(lines[1])){
    lines[1] = (lines[1] || '').slice(0, 20).padEnd(20, ' ') + '3D';
  }
  // 去掉尾部多余空行，补 $$$$
  let body = lines.join('\n').replace(/\n+$/, '');
  if (!/M\s+END/.test(body)) body += '\nM  END';
  return body + '\n$$$$\n';
}

function countAtoms(mb){
  const lines = mb.split('\n');
  // 找 counts 行（含 V2000/V3000 或前 6 行）
  for (let i = 3; i < Math.min(6, lines.length); i++){
    if (/V2000|V3000/.test(lines[i])) return parseInt(lines[i].slice(0,3),10) || 0;
  }
  return 0;
}

/* =========================================================================
 * 3D 渲染（Canvas，无外部依赖；球棍 + 深度排序 + 光照）
 * ======================================================================= */
const CPK = {H:'#ffffff',C:'#3f4650',N:'#3050f8',O:'#ff2d2d',F:'#8fe04f',Cl:'#28e028',
  Br:'#a62929',I:'#9b009b',S:'#ffd92d',P:'#ff8c1a',B:'#ff9bb0',Si:'#c8a0f0',Se:'#ffa100',
  As:'#bd80e3',Na:'#ab5cf2',K:'#8f40d4',Ca:'#3dff00',Fe:'#e06633',Zn:'#7d80b0',Mg:'#8aff00',
  Li:'#cc80ff',Al:'#bfa6a6',Cu:'#c88033',Mn:'#9c7ac7',Ni:'#50d050',Co:'#f090a0'};
const RAD = {H:0.28,C:0.42,N:0.40,O:0.38,F:0.34,Cl:0.50,Br:0.54,I:0.60,S:0.50,P:0.50,B:0.44,Si:0.50};
const colorOf = e => CPK[e] || '#b8c0cc';
const radiusOf = e => RAD[e] || 0.44;

let scene = null;
let rotX = -0.45, rotY = 0.6, zoom = 1, spin = false;

function parseMolblockForRender(mb){
  const lines = mb.split('\n');
  let ci = -1;
  for (let i = 3; i < Math.min(6, lines.length); i++) if (/V2000|V3000/.test(lines[i])) { ci = i; break; }
  if (ci < 0) return null;
  const na = parseInt(lines[ci].slice(0,3),10)||0;
  const nb = parseInt(lines[ci].slice(3,6),10)||0;
  const atoms = [], bonds = [];
  let p = ci+1;
  for (let k=0;k<na;k++,p++){
    const L = lines[p]||'';
    const x=parseFloat(L.slice(0,10)), y=parseFloat(L.slice(10,20)), z=parseFloat(L.slice(20,30));
    let sym=(L.slice(31,34)||'').trim(); sym=sym.replace(/[^A-Za-z]/g,'');
    sym = sym ? sym[0].toUpperCase()+sym.slice(1).toLowerCase() : 'C';
    atoms.push({el:sym, x:isFinite(x)?x:0, y:isFinite(y)?y:0, z:isFinite(z)?z:0});
  }
  for (let k=0;k<nb;k++,p++){
    const L=lines[p]||'';
    const a1=parseInt(L.slice(0,3),10), a2=parseInt(L.slice(3,6),10), t=parseInt(L.slice(6,9),10)||1;
    if (a1&&a2) bonds.push({a1:a1-1,a2:a2-1,type:t});
  }
  return {atoms, bonds};
}

function renderMolblock(mb){
  const m = parseMolblockForRender(mb);
  if (!m) return;
  // 居中
  let c=[0,0,0]; for (const a of m.atoms){c[0]+=a.x;c[1]+=a.y;c[2]+=a.z;}
  const n = m.atoms.length || 1; c=c.map(v=>v/n);
  for (const a of m.atoms){ a.x-=c[0]; a.y-=c[1]; a.z-=c[2]; }
  scene = m;
  $('optSpin').checked ? spin=true : spin=false;
  draw();
}

function rotPoint(p){
  let [x,y,z]=p;
  const cy=Math.cos(rotY), sy=Math.sin(rotY);
  let x1=x*cy+z*sy, z1=-x*sy+z*cy;
  const cx=Math.cos(rotX), sx=Math.sin(rotX);
  let y1=y*cx-z1*sx, z2=y*sx+z1*cx;
  return [x1,y1,z2];
}
function shade(hex, amt){
  const c=hex.replace('#',''); const num=parseInt(c.length===3?c.replace(/(.)/g,'$1$1'):c,16);
  let r=(num>>16)&255,g=(num>>8)&255,b=num&255;
  r=Math.max(0,Math.min(255,r+255*amt)); g=Math.max(0,Math.min(255,g+255*amt)); b=Math.max(0,Math.min(255,b+255*amt));
  return `rgb(${r|0},${g|0},${b|0})`;
}
function draw(){
  const cv = $('view');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  if (!scene){
    ctx.fillStyle='#5b6472'; ctx.font='13px system-ui'; ctx.textAlign='center';
    ctx.fillText('转换后在此显示 3D 结构', W/2, H/2); return;
  }
  const stick = $('optStick').checked;
  let maxR=0.5; for (const a of scene.atoms) maxR=Math.max(maxR, Math.hypot(a.x,a.y,a.z));
  const scale = Math.min(W,H)/2/(maxR*1.5)*zoom;
  const cx=W/2, cy=H/2;
  const rp = scene.atoms.map(a=>{ const p=rotPoint([a.x,a.y,a.z]); return [cx+p[0]*scale, cy+p[1]*scale, p[2]]; });
  const rad = scene.atoms.map(a=>radiusOf(a.el)*scale*(stick?0.55:0.95));

  // 键
  for (const b of scene.bonds){
    const a=rp[b.a1], c=rp[b.a2];
    ctx.lineCap='round'; ctx.strokeStyle='#9aa6b8';
    const w = Math.max(2.5, 0.085*scale);
    if (b.type===2){
      const dx=c[0]-a[0], dy=c[1]-a[1], L=Math.hypot(dx,dy)||1, ox=-dy/L*w*0.45, oy=dx/L*w*0.45;
      ctx.lineWidth=w*0.72;
      ctx.beginPath(); ctx.moveTo(a[0]+ox,a[1]+oy); ctx.lineTo(c[0]+ox,c[1]+oy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a[0]-ox,a[1]-oy); ctx.lineTo(c[0]-ox,c[1]-oy); ctx.stroke();
    } else if (b.type===3){
      const dx=c[0]-a[0], dy=c[1]-a[1], L=Math.hypot(dx,dy)||1, ox=-dy/L*w*0.5, oy=dx/L*w*0.5;
      ctx.lineWidth=w*0.6;
      for (const k of [1,-1,0]){ ctx.beginPath(); ctx.moveTo(a[0]+ox*k,a[1]+oy*k); ctx.lineTo(c[0]+ox*k,c[1]+oy*k); ctx.stroke(); }
    } else if (b.type===4){
      ctx.lineWidth=w;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke();
      ctx.strokeStyle='#c3ccda'; ctx.lineWidth=Math.max(1, w*0.22); ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle='#9aa6b8';
    } else {
      ctx.lineWidth=w;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke();
    }
  }
  // 原子（按深度排序，远→近）
  const order = scene.atoms.map((_,i)=>i).sort((i,j)=>rp[i][2]-rp[j][2]);
  for (const i of order){
    const p=rp[i], r=Math.max(2.2, rad[i]), el=scene.atoms[i].el;
    const g=ctx.createRadialGradient(p[0]-r*0.35,p[1]-r*0.38,r*0.08, p[0],p[1],r*1.05);
    const col=colorOf(el);
    g.addColorStop(0,'#ffffff'); g.addColorStop(0.30,col); g.addColorStop(1, shade(col,-0.42));
    ctx.fillStyle=g;
    ctx.beginPath(); ctx.arc(p[0],p[1],r,0,Math.PI*2); ctx.fill();
    if (!stick && r>10){
      ctx.fillStyle = (el==='H'||el==='C') ? '#d5dbe4' : '#0b0d10';
      ctx.font=`${Math.max(8, r*0.85)}px system-ui`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(el[0], p[0], p[1]);
    }
  }
}

/* 交互 */
(function(){
  const cv = $('view');
  let drag=false, lx=0, ly=0;
  const start=e=>{ drag=true; const t=e.touches?e.touches[0]:e; lx=t.clientX; ly=t.clientY; };
  const move=e=>{ if(!drag) return; const t=e.touches?e.touches[0]:e;
    rotY += (t.clientX-lx)*0.011; rotX -= (t.clientY-ly)*0.011;
    lx=t.clientX; ly=t.clientY; draw(); if(e.touches) e.preventDefault(); };
  const end=()=>{ drag=false; };
  cv.addEventListener('mousedown',start); window.addEventListener('mousemove',move); window.addEventListener('mouseup',end);
  cv.addEventListener('touchstart',start,{passive:true}); cv.addEventListener('touchmove',move,{passive:false}); cv.addEventListener('touchend',end);
  cv.addEventListener('wheel',e=>{ e.preventDefault(); zoom *= (e.deltaY<0?1.1:0.9); zoom=Math.max(0.2,Math.min(8,zoom)); draw(); },{passive:false});
  cv.addEventListener('dblclick',()=>{ rotX=-0.45; rotY=0.6; zoom=1; draw(); });
})();
setInterval(()=>{ if(spin && scene){ rotY += 0.012; draw(); } }, 40);
window.addEventListener('resize', ()=>{ if(scene) draw(); });

/* =========================================================================
 * UI 绑定
 * ======================================================================= */
const EXAMPLE =
`phenol
  Mrv  2D

 13 13  0  0  0  0  0  0  0  0999 V2000
   -2.5295   -0.9820    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.1121   -0.4910    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0218   -1.4730    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.4392   -0.9820    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.7226    0.4910    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.5888    1.4730    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.8286    0.9820    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -3.6633    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.2617   -2.9459    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.5731   -1.9640    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.1400    0.9820    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    0.8722    2.9459    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.9625    1.9640    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  2  0
  3  4  1  0
  4  5  2  0
  5  6  1  0
  6  7  2  0
  7  2  1  0
  1  8  1  0
  3  9  1  0
  4 10  1  0
  5 11  1  0
  6 12  1  0
  7 13  1  0
M  END
$$$$
caffeine
  Mrv  2D

 24 25  0  0  0  0  0  0  0  0999 V2000
    3.4255   -0.9059    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.3660    0.1559    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    2.6023    1.6372    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2665    2.3197    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    0.2047    1.2602    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8842   -0.0771    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0659   -1.3342    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.7454   -2.6715    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.4320   -1.2541    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
   -2.1115    0.0832    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -3.6094    0.1633    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2932    1.3403    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
   -1.9727    2.6775    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.2503   -2.5112    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    4.4850   -1.9677    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    4.4873    0.1536    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    2.3637   -1.9654    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.9395    2.3168    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.6522    4.0148    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.6355    3.3571    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.3100    1.9980    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.0686   -3.7683    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.5074   -1.6929    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.9932   -3.3295    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  1  0
  3  4  2  0
  4  5  1  0
  5  6  2  0
  6  7  1  0
  7  8  2  0
  7  9  1  0
  9 10  1  0
 10 11  2  0
 10 12  1  0
 12 13  1  0
  9 14  1  0
  6  2  1  0
 12  5  1  0
  1 15  1  0
  1 16  1  0
  1 17  1  0
  3 18  1  0
 13 19  1  0
 13 20  1  0
 13 21  1  0
 14 22  1  0
 14 23  1  0
 14 24  1  0
M  END
$$$$
aspirin
  Mrv  2D

 21 21  0  0  0  0  0  0  0  0999 V2000
    3.8551   -0.4172    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.5270    0.2801    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4669    1.7789    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    1.2591   -0.5214    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
   -0.0690    0.1759    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -0.1291    1.6747    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.4572    2.3721    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.7251    1.5706    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.6650    0.0718    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.3369   -0.6255    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2768   -2.1243    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0513   -2.8216    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
   -2.5447   -2.9258    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    5.1831   -1.1145    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    4.5524    0.9108    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    3.1578   -1.7453    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    1.1388    2.4762    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -1.5173    3.8709    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -4.0531    2.2679    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -3.9329   -0.7297    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -2.4846   -4.4246    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  2  0
  2  4  1  0
  4  5  1  0
  5  6  2  0
  6  7  1  0
  7  8  2  0
  8  9  1  0
  9 10  2  0
 10 11  1  0
 11 12  2  0
 11 13  1  0
 10  5  1  0
  1 14  1  0
  1 15  1  0
  1 16  1  0
  6 17  1  0
  7 18  1  0
  8 19  1  0
  9 20  1  0
 13 21  1  0
M  END
$$$$`;

$('btnLoadEx').addEventListener('click', ()=>{ $('input').value = EXAMPLE; $('btnConvert').disabled = !rdkitReady; });
$('btnClear').addEventListener('click', ()=>{
  $('input').value=''; window.__lastSDF=''; scene=null; draw();
  $('statusIn').className='status'; $('statusIn').textContent='等待输入。';
  $('statusOut').className='status'; $('statusOut').textContent='等待转换。';
  $('btnCopy').disabled=true; $('btnDownload').disabled=true; $('molInfo').textContent='—';
});
$('input').addEventListener('input', ()=>{ $('btnConvert').disabled = !rdkitReady || !$('input').value.trim(); });
$('btnConvert').addEventListener('click', convertAll);

$('btnFile').addEventListener('click', ()=> $('fileInput').click());
$('fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ $('input').value = r.result; $('btnConvert').disabled=!rdkitReady; };
  r.readAsText(f);
});

// 拖拽
const drop = $('drop'), cvInit = $('view');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e=>{
  const f=e.dataTransfer.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=()=>{ $('input').value=r.result; $('btnConvert').disabled=!rdkitReady; }; r.readAsText(f);
});
drop.addEventListener('click', ()=> $('fileInput').click());
// 页面级拖拽也接受
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e=>{
  const f=e.dataTransfer && e.dataTransfer.files[0]; if(!f) return;
  e.preventDefault();
  const r=new FileReader(); r.onload=()=>{ $('input').value=r.result; $('btnConvert').disabled=!rdkitReady; }; r.readAsText(f);
});

$('btnCopy').addEventListener('click', async ()=>{
  const t=window.__lastSDF||''; if(!t) return;
  try{ await navigator.clipboard.writeText(t); $('statusOut').textContent += '\n已复制到剪贴板。'; }
  catch(e){ $('statusOut').textContent += '\n复制失败（浏览器限制）。'; }
});
$('btnDownload').addEventListener('click', ()=>{
  const t=window.__lastSDF||''; if(!t) return;
  const blob=new Blob([t],{type:'chemical/x-mdl-sdfile'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='converted_3d.sdf'; a.click();
  URL.revokeObjectURL(a.href);
});
$('optStick').addEventListener('change', draw);
$('optSpin').addEventListener('change', ()=>{ spin = $('optSpin').checked; });

draw();
