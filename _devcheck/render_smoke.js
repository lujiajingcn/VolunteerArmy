/* 渲染层冒烟测试：用 DOM + WebGL 桩在 Node 里真实执行 index.html 的完整脚本，
   再驱动「初始化 → 开局 → 若干帧渲染」的流程，捕获运行时错误。
   语法检查（node --check）只能证明能解析，这里才能证明能跑。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/* ---------------- 2D 上下文桩 ---------------- */
function ctx2dStub() {
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1280, height: 720 };
      if (k === 'measureText') return () => ({ width: 10 });
      return () => ctx2dStub();
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
/* ---------------- WebGL 桩 ---------------- */
const GL_CONSTS = {
  VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
  ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
  TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125,
  TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, REPEAT: 10497, TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240, LINEAR_MIPMAP_LINEAR: 9987, LINEAR: 9729, NEAREST: 9728,
  TEXTURE0: 33984, TRIANGLES: 4, FLOAT: 5126, DEPTH_TEST: 2929, LEQUAL: 515, CULL_FACE: 2884,
  COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256, BLEND: 3042,
};
function glStub() {
  const store = {};
  return new Proxy({}, {
    get(t, k) {
      if (k in store) return store[k];
      if (k in GL_CONSTS) return GL_CONSTS[k];
      const fn = function (...args) {
        switch (k) {
          case 'getShaderParameter': case 'getProgramParameter': return true;
          case 'getAttribLocation': return 0;
          case 'getUniformLocation': return { loc: k };
          case 'createShader': case 'createProgram': case 'createBuffer': case 'createTexture': return { obj: k };
          case 'getShaderInfoLog': case 'getProgramInfoLog': return '';
          case 'getParameter': return 16384;
          case 'getError': return 0;
          default: return undefined;
        }
      };
      store[k] = fn;
      return fn;
    },
    set(t, k, v) { store[k] = v; return true; },
  });
}
/* ---------------- DOM 桩 ---------------- */
function makeEl(id) {
  const e = {
    id: id || '', tagName: 'DIV', children: [],
    style: new Proxy({}, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => { t[k] = v; return true; } }),
    dataset: {}, className: '', textContent: '', innerHTML: '', value: '',
    width: 1280, height: 720,
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
    getContext(type) { return type === 'webgl' || type === 'experimental-webgl' ? glStub() : ctx2dStub(); },
    focus() { }, blur() { }, click() { },
    setAttribute() { }, getAttribute() { return null; },
    get firstChild() { return this.children[0] || null; },
    get parentNode() { return null; },
  };
  return e;
}
const elems = new Map();
const doc = {
  getElementById(id) { if (!elems.has(id)) elems.set(id, makeEl(id)); return elems.get(id); },
  createElement(tag) { return makeEl(tag); },
  addEventListener() { }, removeEventListener() { },
  querySelector() { return makeEl('q'); },
  querySelectorAll() { return []; },
  body: makeEl('body'),
  documentElement: makeEl('html'),
  activeElement: null,
  pointerLockElement: null,
  exitPointerLock() { },
};

const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, TypeError, RangeError,
  Map, Set, Promise, Symbol, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  Float32Array, Float64Array, Uint16Array, Uint32Array, Uint8Array, Int32Array, Int16Array, ArrayBuffer,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => { },
  document: doc,
  navigator: { userAgent: 'node-smoke', mediaDevices: { getUserMedia: () => Promise.reject(new Error('no mic')) } },
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  addEventListener() { }, removeEventListener() { },
  speechSynthesis: null, SpeechSynthesisUtterance: function () { },
  localStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
let phase = 'load';
try {
  vm.runInContext(code, ctx, { filename: 'game.js' });
  console.log('① 脚本执行（含 WebGL/DOM 初始化）: OK');
} catch (e) {
  console.error('① 脚本执行失败 [' + phase + ']: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

/* ---------------- 驱动运行 ----------------
   注意：脚本顶层的 const/let 属于 script scope，不会挂到 sandbox 上，
   所以内部变量与函数一律通过 vm.runInContext 求值来访问。 */
const run = expr => vm.runInContext(expr, ctx);
const report = [];
function step(label, fn) {
  try { fn(); report.push('  ✔ ' + label); }
  catch (e) {
    report.push('  ✘ ' + label + ' → ' + e.message);
    report.push('     ' + (e.stack || '').split('\n')[1]);
    throw new Error('FAIL@' + label + ': ' + e.message);
  }
}
const FRAME = 'stepOnce(1/60); camFollow(1/60); updateFpsFeel(1/60); draw(); updateHUD(1/60);';
function frames(n) { run('for (let i=0;i<' + n + ';i++){ ' + FRAME + ' }'); }

try {
  step('initWorld(20240915)', () => run('initWorld(20240915)'));
  step('resize()', () => run('resize()'));
  step('startGame()', () => run('startGame(20240915)'));
  step('部署阶段帧 ×30', () => frames(30));
  step('结束部署', () => run('World.deployDone = true; World.t = 130;'));
  step('战斗帧 ×600（约 10 秒）', () => frames(600));
  step('视角旋转 + 前进 + 持续射击', () => {
    run('Cam.yaw = 1.2; Cam.pitch = -0.05; Input.key["w"] = true; Input.mouseDown = true;');
    frames(240);
    run('Input.key["w"] = false; Input.mouseDown = false;');
  });
  step('触发伏击 + 全队交火', () => {
    run('triggerAmbush("mine");');
    frames(900);
  });
  step('语音指令链路 → 解析 → 执行', () => {
    run('["全体，隐蔽","老周，压制","反坦克组，打坦克","全体，打卡车","铁头，搬密码箱","全体，撤离"]' +
      '.forEach(t => issueCommand(t, "smoke"));');
    frames(600);
  });
  step('准星标记 / 雷达 / 字幕', () => {
    run('setViewMarker(); drawMinimap(); renderSubs();');
  });
  step('换弹 / 手雷 / 蹲下', () => {
    run('Input.key["control"] = true; tryReload(World.player);' +
      'throwGrenade(World.player, World.player.x + 130, World.player.y, "grenade");');
    frames(300);
  });
  step('火箭弹 + 爆炸 + 载具损毁', () => {
    run('const at = World.units.find(u => u.weaponKey === "at" && !u.dead);' +
      'if (at) { for (let i = 0; i < 3; i++) spawnRocket(at, { x: at.x + 400, y: at.y }); }' +
      'explosion(1000, 650, 90, 120, "ally", "rocket", 1.0, "rocket");');
    frames(240);
  });
  step('玩家阵亡 → 结算界面', () => {
    run('damageUnit(World.player, 9999, null, "bullet");');
    frames(60);
    run('endGame("失败", "冒烟测试");');
    frames(30);
  });
  step('重开一局（释放 GL 缓冲 + 状态清零）', () => {
    run('startGame(777);');
    frames(180);
  });
} catch (e) {
  console.log(report.join('\n'));
  console.error('\n渲染层冒烟测试: 失败\n' + e.message);
  process.exit(1);
}
console.log(report.join('\n'));
console.log('\n状态: ' + run(
  '"t=" + World.t.toFixed(0) + "s 单位=" + World.units.length + " 车辆=" + World.vehicles.length +' +
  '" 弹丸=" + World.projectiles.length + " 特效=" + World.fx.length +' +
  '" 玩家hp=" + (World.player ? World.player.hp.toFixed(0) : "-") +' +
  '" 绘制调用=" + _drawCalls'));
console.log('相机: ' + run(
  '"pos=(" + Cam.x.toFixed(0) + "," + Cam.z.toFixed(0) + ") 眼高=" + Cam.y.toFixed(1) +' +
  '" yaw=" + Cam.yaw.toFixed(2) + " pitch=" + Cam.pitch.toFixed(2)'));
console.log('场景网格: ' + run('Object.keys(SCENE).filter(k => SCENE[k]).join(", ")'));
console.log('模型: 士兵=' + run('!!MESH_SOLDIER') + ' 倒地=' + run('!!MESH_SOLDIER_DOWN') +
  ' 武器=' + run('!!MESH_WPN') + ' 车辆=' + run('Object.keys(MESH_VEH).length'));
console.log('\n渲染层冒烟测试: 全部通过 ✔');
