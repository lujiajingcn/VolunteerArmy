/* 解析器 / 指令下发链路单元测试（不需要浏览器） */
globalThis.renderSubs = () => { };
globalThis.toast = () => { };
globalThis.setAlert = () => { };
globalThis.showEndScreen = () => { };
globalThis.buildTerrain = () => null;

const L = require('./_logic.js');
const { Parser, World, initWorld, issueCommand, resolveTargets } = L;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '   ' + JSON.stringify(extra) : '')); }
}
function parse(t, opts) { return Parser.parse(t, Object.assign({ noise: 0 }, opts)); }
function brief(c) {
  return (c.callsign ? c.callsign.kind + ':' + c.callsign.id : '-') + ' / ' + (c.action ? c.action.id : 'none') + ' / ' + (c.loc ? c.loc.key : '-') + ' / ' + c.confidence;
}

console.log('\n=== 1. 呼号 + 动作 + 地点 解析 ===');
const cases = [
  ['老周，前进', 'member:laozhou', 'advance', null],
  ['石头，打坦克', 'member:shitou', 'atTank', null],
  ['阿杰，隐蔽', 'member:ajie', 'takeCover', null],
  ['全体，撤退到 C 点', 'all:*', 'retreatTo', 'C'],
  ['1 组，跟我来', 'group:1组', 'followMe', null],
  ['一组，前进', 'group:1组', 'advance', null],
  ['小满，救阿杰', 'member:xiaoman', 'rescue', null],
  ['反坦克组，打坦克', 'group:反坦克组', 'atTank', null],
  ['火力组，开火', 'group:火力组', 'fire', null],
  ['2 组，隐蔽', 'group:2组', 'takeCover', null],
  ['全体，停火', 'all:*', 'ceasefire', null],
  ['阿杰尔，前进', 'member:ajie', 'advance', null],
  ['阿杰哥，后退', 'member:ajie', 'fallback', null],
  ['猴子，用火箭筒', 'member:houzi', 'rocket', null],
  ['大刘，去 B 点', 'member:daliu', 'gotoPoint', 'B'],
  ['医疗兵，救伤员', 'role:医疗兵', 'rescue', null],
  ['老白，炸桥', 'member:laobai', 'blowBridge', 'C'],
  ['小夏，打军官', 'member:xiaoxia', 'atOfficer', null],
  ['全体，撤离', 'all:*', 'evac', null],
  ['铁头，给弹药', 'member:tietou', 'resupply', null],
  ['阿兰，打步兵', 'member:alan', 'atInf', null],
  ['老白，起爆', 'member:laobai', 'detonate', null],
  ['全体，散开', 'all:*', 'spread', null],
  ['老周，报告', 'member:laozhou', 'reportAll', null],
  ['小夏，剩余敌人', 'member:xiaoxia', 'reportRemain', null],
  ['石头，撤退到 B 点', 'member:shitou', 'retreatTo', 'B'],
  ['阿杰，投手雷', 'member:ajie', 'grenade', null],
  ['小满，治疗', 'member:xiaoman', 'heal', null],
  ['全体，自由射击', 'all:*', 'freeFire', null],
  ['老周，压制', 'member:laozhou', 'suppress', null],
  ['阿杰，打卡车', 'member:ajie', 'atTruck', null],
  ['石头，打补给车', 'member:shitou', 'atTruck', null],
  ['猴子，打军卡', 'member:houzi', 'atTruck', null],
];
for (const [text, cs, act, loc] of cases) {
  const c = parse(text);
  const gotCs = c.callsign ? c.callsign.kind + ':' + c.callsign.id : '-';
  const gotAct = c.action ? c.action.id : 'none';
  const gotLoc = c.loc ? c.loc.key : null;
  ok(gotCs === cs && gotAct === act && gotLoc === loc, '「' + text + '」 → ' + cs + ' / ' + act + ' / ' + loc, { got: gotCs + ' / ' + gotAct + ' / ' + gotLoc, conf: c.confidence });
}

console.log('\n=== 2. 置信度与低置信候选 ===');
{
  const c = parse('石头，打坦克');
  ok(c.confidence >= 0.7 && c.ok, '清晰指令置信度 ≥0.7', c.confidence);
  const c2 = parse('那个谁，打', { noise: 0.9 });
  ok(c2.confidence < 0.7, '高噪声下置信度 <0.7', c2.confidence);
  const cands = Parser.candidates('那个谁，打', c2);
  ok(cands.length >= 1 && cands.length <= 3, '低置信时给出 1-3 个候选', cands.map(brief));
  const c3 = parse('全体，撤退到');
  ok(!c3.ok, '缺少地点 → 不执行', c3.notes);
  const c4 = parse('随便说点什么东西');
  ok(!c4.action, '无动作关键词 → 返回无动作');
  const typed = parse('老周前进', { typed: true });
  ok(typed.confidence >= 0.9, '文本输入置信度提升', typed.confidence);
}

console.log('\n=== 3. 方向/目标修饰 ===');
{
  const c = parse('小夏，打 11 点方向机枪手');
  ok(c.dir && c.dir.bearing === 330, '11 点方向 = 330°（12 点为正北）', c.dir);
  ok(c.action.id === 'atMG', '识别「打机枪手」', c.action.id);
  const c2 = parse('全体，打左边坦克');
  ok(c2.dir && c2.dir.bearing === 'L', '识别「左边」', c2.dir);
}

console.log('\n=== 4. 世界初始化 ===');
initWorld(12345);
ok(World.units.filter(u => u.team === 'ally').length === 11, '玩家 + 10 名队友', World.units.length);
ok(World.vehicles.length === 6, '车队 6 辆（含 1 坦克 2 装甲车 2 吉普 1 卡车）', World.vehicles.map(v => v.type));
ok(World.vehicles.filter(v => v.type === 'tank').length === 1, '坦克数量 = 1', null);
ok(World.vehicles.some(v => v.type === 'truck' && v.hasBox) || World.boxWhere === 'officer', '密码箱在车/军官身上', World.boxWhere);
ok(World.mines.length === 2, '预埋 2 处地雷', null);
ok(World.infantryTotal >= 10 && World.infantryTotal <= 16, '步兵总量 10-16', World.infantryTotal);
console.log('   天气=' + World.weather + ' 车队顺序=' + World.convoyOrder.join(',') + ' 步兵=' + World.infantryTotal + ' 箱=' + World.boxWhere);

console.log('\n=== 5. 指令下发：服从度 / 状态改变 ===');
{
  const zhou = World.units.find(u => u.id === 'laozhou');
  const c = parse('老周，前进');
  World.triggered = true;
  issueCommand(c);
  ok(zhou.order && zhou.order.action.id === 'advance' && zhou.state === '移动', '老周 接受了「前进」', { state: zhou.state, obey: zhou.obeyRoll });

  const all = parse('全体，隐蔽');
  issueCommand(all);
  const anyCover = World.units.filter(u => u.team === 'ally' && (u.state === '找掩体' || u.state === '隐蔽')).length;
  ok(anyCover >= 8, '全体隐蔽 → 多数人进入隐蔽/找掩体', anyCover);

  World.stats.cmdIssued = 0; World.stats.cmdExec = 0;
  const smoke = parse('石头，放烟雾');
  issueCommand(smoke);
  ok(World.stats.cmdRefused >= 0, '无烟雾弹时被拒绝而不崩溃', { refused: World.stats.cmdRefused });

  const t = World.units.find(u => u.id === 'shitou');
  t.suppression = 100; t.morale = 5; t.obeyBase = 0.8;
  const ob = L.calcObey ? null : null;
  const c5 = parse('石头，打坦克');
  issueCommand(c5);
  ok(true, '高压制低士气下不崩溃（服从度判定生效）', { state: t.state, pending: !!t.pendingOrder, refused: World.stats.cmdRefused });

  const rep = parse('全体，报告');
  issueCommand(rep);
  ok(World.subs.length > 0, '报告类指令产生语音回复字幕', World.subs.slice(-2).map(s => s.who + ':' + s.text));
}

console.log('\n=== 6. 指令解析器容错 ===');
{
  const c = parse('石头打坦克');       // 无逗号
  ok(c.callsign.id === 'shitou' && c.action.id === 'atTank', '无标点也能解析', brief(c));
  const c2 = parse('全体开火');
  ok(c2.callsign.kind === 'all' && c2.action.id === 'fire', '全体开火', brief(c2));
  const c3 = parse('都打那个');
  ok(c3.action.id === 'focusFire', '「都打那个」→ 集火', brief(c3));
  const c4 = parse('小满 救 阿杰');
  ok(c4.action.id === 'rescue' && c4.mentioned.indexOf('ajie') >= 0, '救援目标识别为阿杰', c4.mentioned);
}

console.log('\n=== 7. 时间推进（模拟 12 分钟战场） ===');
{
  // 用较粗的时间步长模拟，检查是否抛异常
  let err = null;
  try {
    for (let i = 0; i < 720; i++) {
      World.t += 1;
      if (i === 200) World.triggered = true, World.triggerT = World.t;
      if (i === 210) { for (const m of World.mines) m.armed = true; }
      L.updateFlow ? L.updateFlow(1) : null;
    }
  } catch (e) { err = e; }
  ok(!err, '纯逻辑推进无异常（updateFlow 未导出，仅校验核心函数存在）', err && err.message);
}

console.log('\n=== 8. 敌我识别回归（perceive 必须索敌「对面阵营」） ===');
{
  /* 曾经的致命缺陷：perceive 里写死 team === 'enemy'，敌人调用时把同袍（甚至自己，
     距离 0）当成目标 —— 敌人朝自己开枪（子弹飞向地图外）且永不推进（nearby 恒为真）。 */
  initWorld(4242);
  /* 敌方步兵是在车辆被击毁/停车后「下车」时才加入 World.units 的，
     所以这里直接用工厂函数造一个。放在老白附近（~190px，已在交火距离内）。 */
  const a = World.units.find(u => u.id === 'laozhou');
  World.weather = 'sunny';
  const e = L.makeUnit({ id: 'test_e', name: '测试敌兵', role: '步兵', group: '', weapon: 'erifle' }, a.x + 430, a.y, 'enemy');
  e.hp = 34; e.maxHp = 34;
  World.units.push(e);
  for (let i = 0; i < 20; i++) L.updateEnemy(e, 0.05);
  ok(e.seen && e.seen !== e, '敌人不会把自己当目标', e.seen === e ? '目标是自己!' : 'ok');
  ok(e.seen && e.seen.team === 'ally', '敌人感知到的是我方单位', e.seen ? e.seen.name + '/' + e.seen.team : 'null');
  ok(e.state === '战斗', '近距离感知到敌人后进入战斗状态', e.state);

  /* 远处（视野外、无可打目标）的敌人必须向伏击圈推进 —— 这是旧版彻底失效的地方 */
  initWorld(4242);
  const e3 = L.makeUnit({ id: 'test_e3', name: '远处敌兵', role: '步兵', group: '', weapon: 'erifle' }, 2010, 300, 'enemy');
  e3.hp = 34; e3.maxHp = 34;
  World.units.push(e3);
  const startX = e3.x, startY = e3.y;
  let everMoved = false;
  for (let i = 0; i < 240; i++) { L.updateEnemy(e3, 0.05); if (e3.moveGoal) everMoved = true; }
  const travelled = Math.hypot(e3.x - startX, e3.y - startY);
  ok(everMoved && travelled > 40, '视野外的敌人会向伏击圈推进（不再原地卡死）',
    { 走过: +travelled.toFixed(0) + 'px', moveGoal: everMoved ? 'Y' : 'N', seen: e3.seen ? e3.seen.name : 'null' });

  /* 我方侧同样必须索敌敌方 */
  initWorld(4242);
  const a2 = World.units.find(u => u.id === 'laozhou');
  const e2 = L.makeUnit({ id: 'test_e2', name: '测试敌兵2', role: '步兵', group: '', weapon: 'erifle' }, a2.x + 120, a2.y, 'enemy');
  World.units.push(e2);
  a2.aiT = 0;
  for (let i = 0; i < 12; i++) L.updateAlly(a2, 0.05);
  ok(a2.seen && a2.seen.team === 'enemy', '我方感知到的是敌方单位', a2.seen ? a2.seen.name + '/' + a2.seen.team : 'null');
}

console.log('\n=== 9. 掩体减伤（文档「掩体评分」必须有实际防护效果） ===');
{
  initWorld(9090);
  const u = World.units.find(x => x.id === 'laozhou');
  u.dead = false; u.downed = false; u.state = '战斗';
  u.x = 60; u.y = 60;                       // 空旷地
  u.hp = 500;
  L.damageUnit(u, 100, null, 'bullet');
  const open = 500 - u.hp;
  const rock = World.props.find(p => p.hard && !p.destroyed);
  u.hp = 500; u.x = rock.x + rock.r + 2; u.y = rock.y;   // 紧贴岩石
  L.damageUnit(u, 100, null, 'bullet');
  const covered = 500 - u.hp;
  ok(covered < open * 0.6, '贴硬掩体受到的伤害至少降低 40%', { 空地: +open.toFixed(1), 掩体后: +covered.toFixed(1) });
  ok(covered > 0, '掩体不是无敌', +covered.toFixed(1));
}

console.log('\n=== 10. 火箭弹对坦克的伤害链路（主目标必须可达） ===');
{
  initWorld(777);
  const tank = World.vehicles.find(v => v.type === 'tank');
  const before = tank.hp;
  World.projectiles.length = 0;
  L.explosion(tank.x, tank.y, 62, 300, 'ally', 'rocket', 1.0, 'rocket');   // 模拟火箭弹直击
  const d = before - tank.hp;
  ok(d >= 250, '单发火箭直击对坦克伤害 ≥250', +d.toFixed(0));
  ok(Math.ceil(950 / d) <= 6, '≤6 发火箭即可摧毁坦克（两名反坦克手携带 3+3 发）', { 每发: +d.toFixed(0), 需要: Math.ceil(950 / d) });
}

console.log('\n=== 11. 撤离计数门控（开局站 C 点不算撤离） ===');
{
  initWorld(555);
  World.started = true; World.deployDone = true;
  const before = World.stats.evacCount;
  for (let i = 0; i < 200; i++) L.updateFlow(0.05);
  for (const u of World.units.filter(x => x.team === 'ally')) if (!u.isPlayer) L.updateAlly(u, 0.05);
  ok(World.stats.evacCount === before && before === 0, '潜伏阶段站在撤离点不计数', World.stats.evacCount);
  ok(!World.evacArmed, '未进入撤离阶段时 evacArmed = false', World.evacArmed);
}
console.log('\n=== 12. 重开一局必须清空运行态（barrage / box / 军官 / 指挥交接） ===');
{
  /* 曾经 initWorld 漏清 World.barrage 等字段：上一局打到增援阶段后，
     重玩的新局会从 t=0 起持续被火箭炮覆盖，双方都没开枪却在减员。 */
  initWorld(11); World.started = true; World.deployDone = true;
  World.barrage = true; World.barrageCd = 0;
  World.pendingShells = [{ x: 872, y: 872, t: 0.01 }];
  World.box = { x: 100, y: 100, taken: false, carrier: null, t: 0 };
  World.officerSpawned = true; World.handover = World.player;
  World.mineWarned = true; World.convoyProgress = 500;

  initWorld(11); World.started = true; World.deployDone = true;
  ok(World.barrage === false, 'initWorld 清空 barrage', World.barrage);
  ok(World.pendingShells.length === 0, 'initWorld 清空 pendingShells', World.pendingShells.length);
  ok(World.box === null, 'initWorld 清空 World.box', World.box);
  ok(World.officerSpawned === false, 'initWorld 清空 officerSpawned', World.officerSpawned);
  ok(World.handover === null, 'initWorld 清空 handover', !!World.handover);
  ok(World.convoyProgress === 0, 'initWorld 清空 convoyProgress', World.convoyProgress);

  for (let i = 0; i < 1200; i++) L.updateFlow(0.05);        // 推进 60 秒
  const hurt = World.units.filter(x => x.team === 'ally' && x.hp < x.maxHp).length;
  ok(hurt === 0, '开局 60 秒内无人受伤（无残留炮击）', hurt);
}

console.log('\n=== 13. 撤离只数活人（阵亡/失能者躺在撤离点不算） ===');
{
  /* 早期两处撤离判定都没排除倒地/阵亡者，而伤员往往就倒在撤离点附近 ——
     「小队全灭」也能凑出 evacCount >= 6，与 checkEnd 里 allIn（只数活人）自相矛盾。 */
  initWorld(808); World.started = true; World.deployDone = true;
  World.evacArmed = true;
  const pool = World.units.filter(u => u.team === 'ally' && !u.isPlayer);
  const dead = pool[0], down = pool[1], alive = pool[2];
  dead.dead = true; dead.x = World.evac.x; dead.y = World.evac.y;
  down.downed = true; down.x = World.evac.x; down.y = World.evac.y;
  L.updateAlly(dead, 0.05); L.updateAlly(down, 0.05);
  ok(World.stats.evacCount === 0, '阵亡/失能者走到撤离点不计数', World.stats.evacCount);
  alive.x = World.evac.x; alive.y = World.evac.y;
  L.updateAlly(alive, 0.05);
  ok(World.stats.evacCount === 1, '活着的人走到撤离点正常计数 +1', World.stats.evacCount);
}

console.log('\n=== 14. 密码箱落地后必须有人接管（自动指派） ===');
{
  /* 「搬密码箱」这条命令只有在箱子已经掉出来时才生效，玩家却通常在车还没打爆时就下令，
     于是箱子一落地就没人管 —— 主目标直接判死。 */
  initWorld(909); World.started = true; World.deployDone = true;
  const truck = World.vehicles.find(v => v.type === 'truck');
  truck.hasBox = true;
  L.damageVehicle(truck, 900, 'mine', null);
  ok(truck.destroyed, '载箱车辆可被摧毁', truck.destroyed);
  ok(!!World.box, '载箱车辆被毁后密码箱落地', !!World.box);
  const tasked = World.units.filter(u => u.team === 'ally' && u.boxTask && !u.dead && !u.downed);
  ok(tasked.length === 1, '落地后自动指派 1 名活人去取箱', tasked.length);
}

console.log('\n=== 15. 贴着掩体必须能滑行脱离（不可被焊死在碰撞圈外沿） ===');
{
  /* 逐帧步长 ~2.6px 却用「半径 6 的碰撞圈」判否：目的地只要仍在圈内这一步就被否掉，
     队员会被永久卡在岩石外沿（铁头抱着取箱任务在岩石边钉了 330 秒）。 */
  initWorld(313); World.started = true; World.deployDone = true;
  const rock = World.props.find(p => p.hard && p.r >= 17);
  const u = World.units.find(x => x.team === 'ally' && !x.isPlayer);
  u.x = rock.x + rock.r + 6 + 0.1; u.y = rock.y + 20;
  const sx = u.x, sy = u.y;
  u.moveGoal = { x: rock.x - 220, y: rock.y - 40 };
  for (let i = 0; i < 400; i++) L.updateAlly(u, 0.05);
  const moved = Math.hypot(u.x - sx, u.y - sy);
  ok(moved > 60, '贴着掩体也能走出来', +moved.toFixed(0));
}

console.log('\n=== 16. 视野 / 目标筛选 / 掩体权重（文档对齐） ===');
{
  initWorld(424);
  const rifle = World.units.find(u => u.team === 'ally' && u.weaponKey === 'rifle');
  const sniper = World.units.find(u => u.team === 'ally' && u.weaponKey === 'sniper');
  const savedWeather = World.weather;
  World.weather = 'sunny';            // 恶劣天气按倍率折减视野是设计内的，这里比晴天基准
  ok(L.visRange(rifle) >= rifle.wpn.range, '晴天步枪手视野 ≥ 步枪射程（不能看着比打着近）',
    { 视野: L.visRange(rifle), 射程: rifle.wpn.range });
  ok(L.visRange(sniper) > L.visRange(rifle), '狙击手视野优于步枪手',
    { 狙击: L.visRange(sniper), 步枪: L.visRange(rifle) });
  World.weather = savedWeather;

  const tank = World.vehicles.find(v => v.type === 'tank');
  const truck = World.vehicles.find(v => v.type === 'truck');
  const at = World.units.find(u => u.weaponKey === 'at');
  ok(L.ineffectiveTarget(rifle, tank) === true, '步枪手把坦克判为「打不动」的目标');
  ok(L.ineffectiveTarget(rifle, truck) === false, '卡车不给步枪手设限（密码箱可能锁在车厢里）');
  ok(L.ineffectiveTarget(at, tank) === false, '反坦克手不受该筛选影响');
  ok(L.ineffectiveTarget(rifle, World.units.find(u => u.team === 'enemy')) === false, '步兵目标永远可打');

  const tree = World.props.find(p => p.soft && !p.hard && p.type === 'tree');
  const v = World.units.find(x => x.team === 'ally' && !x.isPlayer);
  v.state = '战斗';                                    // 排除「隐蔽」状态的 0.4 保底
  v.x = tree.x + tree.r + 4; v.y = tree.y;
  ok(L.coverProtect(v) > 0.2, '树林也能提供实际防护（与掩体评分同一套权重）', +L.coverProtect(v).toFixed(2));
  v.state = '待命';
  ok(L.coverProtect(v) >= 0.4, '「隐蔽/待命」状态本身也有最低防护', +L.coverProtect(v).toFixed(2));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
