/* 端到端战场仿真：不依赖浏览器跑完整 10 分钟战局，检查运行时异常与逻辑闭环 */
globalThis.renderSubs = () => { };
globalThis.toast = () => { };
globalThis.setAlert = () => { };
globalThis.showEndScreen = () => { };
globalThis.Input = { key: {}, mouseWorld: null, mouseDown: false, dragUnit: null };

const L = require('./_logic.js');
const { World, initWorld, Parser, issueCommand, updateFlow, updateVehicles, updateAlly, updatePlayer,
  updateEnemy, updateProjectiles, updateMines, checkEnd, triggerAmbush } = L;

let errors = [];
function nanCheck(tag) {
  for (const u of World.units) if (!isFinite(u.x) || !isFinite(u.y)) errors.push(tag + ' unit NaN: ' + u.id + ' state=' + u.state);
  for (const v of World.vehicles) if (!isFinite(v.x) || !isFinite(v.y)) errors.push(tag + ' vehicle NaN: ' + v.id);
  for (const p of World.projectiles) if (!isFinite(p.x) || !isFinite(p.y)) errors.push(tag + ' proj NaN: ' + p.type);
}

function step(dt) {
  updateFlow(dt);
  updateVehicles(dt);
  for (const u of World.units) {
    if (u.team === 'ally') { u.isPlayer ? updatePlayer(u, dt) : updateAlly(u, dt); }
    else updateEnemy(u, dt);
  }
  updateProjectiles(dt);
  updateMines(dt);
  for (let i = World.smokes.length - 1; i >= 0; i--) { const s = World.smokes[i]; s.t += dt; if (s.t > s.life) World.smokes.splice(i, 1); }
  for (let i = World.fx.length - 1; i >= 0; i--) { const f = World.fx[i]; f.t += dt; if (f.t > f.life) World.fx.splice(i, 1); }
  World.noise = Math.max(0, World.noise - dt * 0.30);
}

function run(seed, label, script) {
  initWorld(seed);
  World.smokes = [];
  World.started = true;
  World.deployDone = true;
  const dt = 0.05;
  let cmdIdx = 0;
  let maxProj = 0, maxUnits = 0, maxFx = 0;
  try {
    for (let i = 0; i < 620 / dt; i++) {
      step(dt);
      maxProj = Math.max(maxProj, World.projectiles.length);
      maxUnits = Math.max(maxUnits, World.units.length);
      maxFx = Math.max(maxFx, World.fx.length);
      if (i % 200 === 0) nanCheck(label + '@' + (i * dt).toFixed(0) + 's');
      if (script) {
        const c = script(World.t, cmdIdx);
        if (c) { cmdIdx++; issueCommand(Parser.parse(c, { noise: World.noise, typed: true })); }
      }
      if (World.over) break;
    }
  } catch (e) {
    errors.push(label + ' EXCEPTION: ' + e.message + '\n' + e.stack.split('\n').slice(0, 4).join('\n'));
  }
  nanCheck(label + '-end');
  const al = World.units.filter(u => u.team === 'ally');
  const en = World.units.filter(u => u.team === 'enemy');
  const shots = al.reduce((s, u) => s + u.shots, 0), hits = al.reduce((s, u) => s + u.hits, 0);
  const eShots = en.reduce((s, u) => s + u.shots, 0);
  console.log('[' + label + '] t=' + World.t.toFixed(0) + 's 结束=' + (World.over ? World.overKind : '未结束') +
    ' | 我方共计' + al.length + ':' + al.filter(u => !u.dead && !u.downed).length + '活/' + al.filter(u => u.downed).length + '伤/' + al.filter(u => u.dead).length + '亡' +
    ' | 敌步兵剩余:' + en.filter(u => !u.dead && !u.mount).length + ' | 车辆:' + World.vehicles.filter(v => !v.destroyed).length + '/' + World.vehicles.length +
    ' | 敌伤亡:' + World.stats.enemyDead + ' 撤离:' + World.stats.evacCount + ' 坦克:' + (World.stats.tankKilled ? '毁' : '存') +
    ' 箱:' + (World.stats.boxTaken ? '得' : '无') + ' 地雷:' + World.stats.minesUsed +
    '\n    射击: 我方' + shots + '发/' + hits + '中  敌方' + eShots + '发' +
    ' | 峰值 弹丸' + maxProj + ' 单位' + maxUnits + ' 特效' + maxFx +
    ' | 指令' + World.stats.cmdIssued + '(执行' + World.stats.cmdExec + '/拒' + World.stats.cmdRefused + ')');
  if (World.overText) console.log('    结算: ' + World.overText);
  return World;
}

/* ---- 场景 A：正常伏击
   一套「称职的」作战计划，而且按事件而非纯计时推进：等到头车真正驶入伏击圈（x<1180）
   才起爆 —— 这才是玩家该有的打法。早期版本死板地在 t=200 起爆，那时头车还在 x≈1670，
   结果头车在半路被打瘫，整个车队堵在 1438，永远进不了伏击圈、也压不到地雷。 ---- */
function boxOrder() {
  /* 密码箱有 62% 概率在军卡后厢：军卡是帆布车厢，全队步枪集火就能打穿，
     不能只丢给反坦克组 —— 他们的 6 发火箭通常已经在坦克身上打光了。 */
  if (World.boxWhere === 'truck') return '全体，打卡车';
  if (World.boxWhere === 'apc') return '反坦克组，打装甲车';
  return '全体，打军官';
}
const SCRIPT_A = (t, i) => {
  const lead = World.vehicles[0];
  const T = World.triggerT;
  if (i === 0 && t > 5) return '全体，隐蔽';
  if (i === 1 && lead && lead.x < 1180) { triggerAmbush('mine'); return '老白，起爆'; }
  if (i === 2 && World.triggered && t > T + 14) return '全体，开火';
  if (i === 3 && World.triggered && t > T + 34) return '反坦克组，打坦克';
  if (i === 4 && World.triggered && t > T + 56) return '老周，压制';
  if (i === 5 && World.triggered && t > T + 78) return boxOrder();
  if (i === 6 && World.triggered && t > T + 110) return '铁头，搬密码箱';
  if (i === 7 && World.triggered && t > T + 200) return '小满，救伤员';
  if (i === 8 && World.triggered && t > T + 230) return '全体，撤离';
  return null;
};
run(20240915, 'A 标准伏击', SCRIPT_A);

/* ---- 场景 B：玩家提前开火（车队远处警觉、坦克炮击） ---- */
run(777, 'B 提前开火', (t, i) => {
  if (i === 0 && t > 60) { triggerAmbush('player'); return '全体，开火'; }
  if (i === 1 && t > 120) return '反坦克组，打坦克';
  if (i === 2 && t > 200) return '火力组，压制';
  if (i === 3 && t > 300) return '全体，撤退到 B 点';
  if (i === 4 && t > 450) return '全体，撤离';
  return null;
});

/* ---- 场景 C：全程不接战（原地待命，车队应通过西侧出口导致失败）
   注意要先下「原地待命」：否则队员会自己去找有射界的掩体、一路挪到公路边，
   车队开过来时自然进入 55px 自卫距离 —— 那测的就不是「不触发」这条路了。 ---- */
run(5150, 'C 不触发', (t, i) => (i === 0 && t > 5) ? '全体，原地待命' : null);

/* ---- 场景 D：多随机种子压力测试 ---- */
for (const s of [1, 2, 3, 42, 999, 31337]) {
  initWorld(s); World.smokes = []; World.started = true; World.deployDone = true;
  try {
    for (let i = 0; i < 60 / 0.05; i++) step(0.05);
  } catch (e) { errors.push('seed' + s + ' EXCEPTION: ' + e.message + ' @' + e.stack.split('\n')[1]); }
  nanCheck('seed' + s);
}
console.log('\n随机种子压力测试 6 组完成');

console.log('\n========== 错误汇总 ==========');
if (!errors.length) console.log('无异常 ✔');
else errors.slice(0, 12).forEach(e => console.log(' ✗ ' + e));
process.exit(errors.length ? 1 : 0);
