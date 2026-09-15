/* 从 index.html 抽出内联脚本，做语法检查 + 解析器/指令链路单元测试 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error('NO SCRIPT FOUND'); process.exit(1); }
const code = scripts.join('\n');
fs.writeFileSync(path.join(__dirname, '_all.js'), code);

/* 只取渲染之前的纯逻辑部分（不含 DOM 访问） */
const cut = code.indexOf('const CV = document.getElementById');
if (cut < 0) { console.error('CUT MARKER NOT FOUND'); process.exit(1); }
const prefix = code.slice(0, cut);
fs.writeFileSync(path.join(__dirname, '_logic.js'), prefix +
  '\nmodule.exports={Parser,World,initWorld,issueCommand,resolveTargets,ACTIONS,ROSTER,GROUPS,' +
  'updateFlow,updateVehicles,updateAlly,updatePlayer,updateEnemy,updateProjectiles,updateMines,' +
  'checkEnd,checkObjectives,endGame,triggerAmbush,spawnReinforcement,allyCentroid,allies,enemies,findCover,coverScore,wayPointAt,POINTS,CFG,' +
  'spawnBullet,updateProjectiles,losFire,losSight,losBlocked,coverProtect,damageUnit,damageVehicle,orderedToFire,explosion,makeUnit,' +
  'visRange,ineffectiveTarget,canSee,dropBox,moveStep,allyTargetSelect,pickTargetByType,dist:null};\n');
console.log('extracted: all=' + code.length + ' chars, logic=' + prefix.length + ' chars');
