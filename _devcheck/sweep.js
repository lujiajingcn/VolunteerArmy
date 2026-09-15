/* 平衡扫描：把「标准伏击」剧本在多个随机种子上跑一遍，看胜率而不是单局运气 */
globalThis.renderSubs = () => { };
globalThis.toast = () => { };
globalThis.setAlert = () => { };
globalThis.showEndScreen = () => { };
globalThis.Input = { key: {}, mouseWorld: null, mouseDown: false, dragUnit: null };

const L = require('./_logic.js');
const { World, initWorld, Parser, issueCommand, updateFlow, updateVehicles, updateAlly, updatePlayer,
  updateEnemy, updateProjectiles, updateMines, triggerAmbush } = L;

function step(dt) {
  updateFlow(dt); updateVehicles(dt);
  for (const u of World.units) { if (u.team === 'ally') { u.isPlayer ? updatePlayer(u, dt) : updateAlly(u, dt); } else updateEnemy(u, dt); }
  updateProjectiles(dt); updateMines(dt);
  for (let i = World.smokes.length - 1; i >= 0; i--) { const s = World.smokes[i]; s.t += dt; if (s.t > s.life) World.smokes.splice(i, 1); }
  for (let i = World.fx.length - 1; i >= 0; i--) { const f = World.fx[i]; f.t += dt; if (f.t > f.life) World.fx.splice(i, 1); }
  World.noise = Math.max(0, World.noise - dt * 0.30);
}
function boxOrder() {
  if (World.boxWhere === 'truck') return '全体，打卡车';
  if (World.boxWhere === 'apc') return '反坦克组，打装甲车';
  return '全体，打军官';
}
const SCRIPT_A = (t, i) => {
  const lead = World.vehicles[0]; const T = World.triggerT;
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

const seeds = [20240915, 1, 7, 42, 123, 777, 2024, 31337, 555, 90901];
let win = 0;
console.log('种子\t\t结果\t我活\t亡\t坦克\t箱\t撤离\t敌伤亡\t天气\t箱位置');
for (const s of seeds) {
  initWorld(s); World.smokes = []; World.started = true; World.deployDone = true;
  const dt = 0.05; let cmdIdx = 0;
  try {
    for (let i = 0; i < 620 / dt; i++) {
      step(dt);
      const c = SCRIPT_A(World.t, cmdIdx);
      if (c) { cmdIdx++; issueCommand(Parser.parse(c, { noise: World.noise, typed: true })); }
      if (World.over) break;
    }
  } catch (e) { console.log(s + '\t异常 ' + e.message); continue; }
  const al = World.units.filter(u => u.team === 'ally');
  const alive = al.filter(u => !u.dead && !u.downed).length;
  const okWin = World.overKind === '成功';
  if (okWin) win++;
  console.log(String(s).padEnd(10) + '\t' + (World.overKind || '未结束') + '\t' + alive + '\t' +
    al.filter(u => u.dead).length + '\t' + (World.stats.tankKilled ? '毁' : '存') + '\t' +
    (World.stats.boxTaken ? '得' : '无') + '\t' + World.stats.evacCount + '\t' +
    World.stats.enemyDead + '\t' + World.weather + '\t' + World.boxWhere);
}
console.log('\n标准剧本胜率: ' + win + '/' + seeds.length);
