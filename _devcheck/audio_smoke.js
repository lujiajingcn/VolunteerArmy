/* 音频引擎离线冒烟测试：用桩 AudioContext 真正跑一遍合成链路。
   目的：在没有浏览器的环境里也能抓到音频层的运行期错误 ——
     · 参数非法（NaN、exponentialRamp 到 0、负频率）→ 真浏览器的 WebAudio 会直接抛异常
     · sfx() 里引用了不存在的音色 id（拼写错误）→ 该音效静默失效，几乎不可能靠听发现
     · 限流 / 距离剔除 / 静音 等控制逻辑是否按预期工作
   这不是「听感」测试（听不出好不好听），但能保证「不会不出声」。 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ' + JSON.stringify(extra) : '')); }
}

/* ---------------------------------------------------- 桩 WebAudio */
class Param {
  constructor(v) { this.value = v || 0; }
  _chk(v, where) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('参数非有限值 @' + where + ': ' + v);
    if (v < 0) throw new Error('参数为负 @' + where + ': ' + v);
  }
  setValueAtTime(v, t) { this._chk(v, 'setValueAtTime'); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this._chk(v, 'linearRamp'); this.value = v; return this; }
  /* 真浏览器的 exponentialRamp 不允许目标为 0（会抛 RangeError） */
  exponentialRampToValueAtTime(v, t) {
    this._chk(v, 'exponentialRamp');
    if (v <= 0) throw new Error('exponentialRampToValueAtTime 目标必须 > 0，实际 ' + v);
    this.value = v; return this;
  }
  setTargetAtTime(v, t, c) { this._chk(v, 'setTarget'); this.value = v; return this; }
  cancelScheduledValues(t) { return this; }
}
class Node {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this._out = []; }
  connect(dest) {
    if (!dest || typeof dest !== 'object') throw new Error(this.kind + '.connect() 目标非法: ' + dest);
    this._out.push(dest); this.ctx._edges++; return dest;
  }
  disconnect() { this._out.length = 0; }
}
class Gain extends Node { constructor(c) { super(c, 'gain'); this.gain = new Param(1); } }
class Osc extends Node {
  constructor(c) { super(c, 'osc'); this.type = 'sine'; this.frequency = new Param(440); this.detune = new Param(0); this._started = false; }
  start(t) { this._started = true; this.ctx._starts++; }
  stop(t) { }
}
class BufSrc extends Node {
  constructor(c) { super(c, 'bufsrc'); this.buffer = null; this.loop = false; this.playbackRate = new Param(1); }
  start(t, off, dur) {
    if (!this.buffer) throw new Error('BufferSource.start() 前未设置 buffer（会静音）');
    this.ctx._starts++;
  }
  stop() { }
}
class Bq extends Node {
  constructor(c) { super(c, 'bq'); this.type = 'lowpass'; this.frequency = new Param(350); this.Q = new Param(1); this.gain = new Param(0); }
}
class Pan extends Node { constructor(c) { super(c, 'pan'); this.pan = new Param(0); } }
class Comp extends Node {
  constructor(c) {
    super(c, 'comp'); this.threshold = new Param(-24); this.knee = new Param(30);
    this.ratio = new Param(12); this.attack = new Param(0.003); this.release = new Param(0.25);
  }
}
class FakeAC {
  constructor() {
    this.sampleRate = 48000; this.currentTime = 0; this.state = 'running';
    this.destination = new Node(this, 'dest');
    this._edges = 0; this._starts = 0; this._nodes = [];
  }
  _reg(n) { this._nodes.push(n); return n; }
  createGain() { return this._reg(new Gain(this)); }
  createOscillator() { return this._reg(new Osc(this)); }
  createBufferSource() { return this._reg(new BufSrc(this)); }
  createBiquadFilter() { return this._reg(new Bq(this)); }
  createStereoPanner() { return this._reg(new Pan(this)); }
  createDynamicsCompressor() { return this._reg(new Comp(this)); }
  createBuffer(ch, n, rate) {
    const data = new Float32Array(n);
    return { numberOfChannels: ch, length: n, sampleRate: rate, getChannelData: () => data };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
/* ---------------------------------------------------- 环境桩 */
globalThis.renderSubs = () => { };
globalThis.toast = () => { };
globalThis.setAlert = () => { };
globalThis.showEndScreen = () => { };
globalThis.buildTerrain = () => null;
globalThis.Input = { key: {}, mouseWorld: null, mouseDown: false, dragUnit: null };
globalThis.window = { AudioContext: FakeAC, localStorage: undefined };

const L = require('./_logic.js');
const { World, initWorld, Sound, sfx, initAudio, bootAudio, updateAudio, startAmbient, SYN, SND } = L;

console.log('\n=== 1. 惰性初始化 / 用户手势启动 ===');
initWorld(2024);
World.started = true; World.deployDone = true;
Object.assign(World.cam, { x: World.player.x, y: World.player.y });
let booted = false;
try { booted = bootAudio(); } catch (e) { fail++; console.log('  ✗ bootAudio 抛异常: ' + e.message); }
ok(booted === true, 'bootAudio 应在有 AudioContext 时返回 true');
ok(Sound.ok === true, 'Sound.ok 应为 true');
ok(Sound.ctx instanceof FakeAC, 'AudioContext 已创建');
ok(!!Sound.ambNodes, '环境音节点已建立（风/雨/虫鸣的载体）');
ok(Sound.engines.length === 0, '引擎循环声按需惰性创建（bootAudio 阶段还不建）', Sound.engines.length);
/* 幂等：重复调用不应重复建图 */
try { bootAudio(); } catch (e) { fail++; console.log('  ✗ 重复 bootAudio 抛异常: ' + e.message); }
ok(!!Sound.ambNodes, '重复 bootAudio 未破坏环境音节点');
/* 车辆引擎循环声由每帧 updateAudio 惰性补齐 */
updateAudio(0.016);
ok(Sound.engines.length === 4, 'updateAudio 后补足 4 路引擎循环声', Sound.engines.length);
updateAudio(0.016);
ok(Sound.engines.length === 4, '重复 updateAudio 不应重复创建引擎节点');

console.log('\n=== 2. 全部音色 id 都能合成且不抛异常 ===');
const ids = Object.keys(SYN);
ok(ids.length > 20, '音色数量合理（>20）', ids.length);
/* 空间化 / 本地 / 极近 / 极远 / 带各选项，逐一覆盖 */
const L0 = { x: World.player.x, y: World.player.y };
const variants = [
  { tag: '本地', args: [null, null, { local: true }] },
  { tag: '贴脸', args: [L0.x + 5, L0.y + 5, null] },
  { tag: '中距', args: [L0.x + 400, L0.y + 120, null] },
  { tag: '边界', args: [L0.x + 900, L0.y - 300, { gain: 1.2 }] },
  { tag: '超远', args: [L0.x + 9000, L0.y, null] },
  { tag: '带延迟', args: [L0.x + 60, L0.y, { delay: 0.16, gap: 0 }] },
];
for (const id of ids) {
  for (const v of variants) {
    try { sfx(id, v.args[0], v.args[1], Object.assign({ force: true }, v.args[2] || {})); }
    catch (e) { fail++; console.log('  ✗ sfx("' + id + '", ' + v.tag + ') 抛异常: ' + e.message); }
  }
}
ok(true, '全部 ' + ids.length + ' 个音色 × ' + variants.length + ' 种空间条件完成');
/* 未知 id 必须安全忽略（不再抛异常） */
try { sfx('__no_such_sound__', 0, 0); sfx(undefined, 0, 0); pass++; }
catch (e) { fail++; console.log('  ✗ 未知音效 id 抛异常: ' + e.message); }

console.log('\n=== 3. sfx 调用点的 id 拼写与音色表一致 ===');
/* 从 index.html 里把所有 sfx('字面量' 抽出来，逐个核对是否真有对应音色。
   这是最容易被忽略的一类 bug：打错一个字母，那条音效就永远不出声。 */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const calls = [...html.matchAll(/sfx\(\s*'([a-zA-Z][A-Za-z0-9_]*)'/g)].map(m => m[1]);
const uniq = [...new Set(calls)].sort();
ok(uniq.length > 20, '抽取到足够的 sfx 调用点', uniq.length);
const missing = uniq.filter(id => !SYN[id]);
ok(missing.length === 0, 'sfx 调用点全部有对应音色实现', missing);
/* 反向：音色表里定义了、但没有任何调用点的（可能是死代码，仅提示不判失败） */
const unused = ids.filter(id => uniq.indexOf(id) < 0);
if (unused.length) console.log('  · 未被直接调用的音色（可能由 BOOM 表/间接触发）: ' + unused.join(', '));
/* SND 音量表是 sfx 的默认参数来源，键必须都能落到音色表上 */
const sndOrphan = Object.keys(SND).filter(id => !SYN[id]);
ok(sndOrphan.length === 0, 'SND 音量表的每个键都有对应音色', sndOrphan);

console.log('\n=== 4. 每帧 updateAudio 在真实战场状态下不抛异常 ===');
/* 用真实战场推进驱动音频层：车辆入画 → 引擎声、夜战 → 虫鸣、爆炸 → 压限与耳鸣 */
World.weather = 'night';
World.vehicles.forEach((v, i) => { if (v.team === 'enemy') v.speed = 30 + i; v.destroyed = false; });
let audioErr = 0;
try {
  for (let i = 0; i < 900; i++) {
    World.t += 0.016;
    /* 让相机绕玩家转一圈，覆盖空间化的各个方位角（声像 pan 的两侧） */
    World.cam.x = World.player.x + Math.cos(i * 0.05) * 30;
    World.cam.y = World.player.y + Math.sin(i * 0.05) * 30;
    updateAudio(0.016);
  }
} catch (e) { audioErr++; fail++; console.log('  ✗ updateAudio 抛异常 @' + World.t.toFixed(1) + 's: ' + e.message); }
ok(audioErr === 0, '900 帧 updateAudio 无异常');

console.log('\n=== 5. 限流预算 / 同类合并 ===');
/* 全队机枪齐射：同一帧内几十发，必须被 SND_GAP 与预算上限截断，否则会削波爆音 */
Sound.last = {}; Sound.budget = [];
const before = Sound.ctx._starts;
for (let i = 0; i < 300; i++) sfx('rifle', L0.x + 30 + i, L0.y, { force: false });
const riflePlays = Sound.ctx._starts - before;
ok(riflePlays < 300, '300 次同帧步枪射击被限流（实际合成 ' + riflePlays + ' 次）');
ok(Sound.budget.length <= 26, '每 0.1s 的合成预算不超过 26 条', Sound.budget.length);
/* 超远距离必须整条剔除，连合成都不该发生 */
Sound.last = {}; Sound.budget = [];
const b2 = Sound.ctx._starts;
for (let i = 0; i < 50; i++) { const t = Sound.ctx.currentTime; sfx('explosion', L0.x + 20000, L0.y, { force: true }); Sound.ctx.currentTime = t; }
ok(Sound.ctx._starts === b2, '超出 max 距离的爆炸不产生任何合成', Sound.ctx._starts - b2);

console.log('\n=== 6. 静音 / 音量 / 偏好读写 ===');
Sound.muted = true; Sound.vol = 0.62;
updateAudio(0.016);
ok(Math.abs(Sound.master.gain.value - 0) < 1e-6, '静音后 master 增益归零', Sound.master.gain.value);
Sound.muted = false;
updateAudio(0.016);
ok(Math.abs(Sound.master.gain.value - 0.62) < 1e-6, '取消静音后 master 增益恢复', Sound.master.gain.value);
/* 静态空间音在极近处增益必须为正（否则「听得见但没声音」很难排查） */
Sound.last = {}; Sound.budget = [];
const b3 = Sound.ctx._starts;
sfx('rifle', L0.x, L0.y, { force: true });
ok(Sound.ctx._starts > b3, '零距离射击仍然发声');
/* 无 AudioContext 时必须安全降级（老浏览器 / 隐私模式） */
Sound.failed = true; Sound.ok = false;
try { sfx('rifle', 0, 0); updateAudio(0.016); pass++; }
catch (e) { fail++; console.log('  ✗ 音频不可用时 sfx/updateAudio 抛异常: ' + e.message); }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
