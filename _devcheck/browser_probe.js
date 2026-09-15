/* 真实浏览器端到端探针（无第三方依赖）：
   用 Edge/Chrome 的 headless + CDP（Node 内置 WebSocket）真的打开 index.html，
   点「开始任务」，然后直接读页面里的 Sound 对象状态。

   离线桩测试只能证明「逻辑不抛异常」；只有这里能证明：
     · 真 Chromium 里 new AudioContext() 真的成功、音频图真的连到 destination
     · 爆炸类音效真的合成出了振荡器/噪声源节点（而不是被 SYN 里缺失的 id 静默吞掉）
     · 静音按钮真的改到了 master 增益与 localStorage
   用法: node browser_probe.js   （截图落在 shots/） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge/Chrome'); process.exit(2); }

const root = path.join(__dirname, '..');
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/');
const outDir = path.join(__dirname, 'shots');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
const PORT = 9333 + (process.pid % 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'va-probe-'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? '   ' + JSON.stringify(x) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--no-sandbox', '--mute-audio',
  '--allow-file-access-from-files',
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    const handlers = {};
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method && handlers[m.method]) handlers[m.method](m.params);
    });
    ws.addEventListener('error', e => reject(new Error('WS error')));
    ws.addEventListener('open', () => resolve({
      on: (method, fn) => { handlers[method] = fn; },
      send: (method, params) => new Promise((res, rej) => {
        const i = ++id; pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      }),
      close: () => ws.close(),
    }));
  });
}

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端口未就绪');
}

(async () => {
  let client = null;
  try {
    const wsUrl = await waitForTarget();
    client = await cdpConnect(wsUrl);
    const errors = [];
    client.on('Runtime.exceptionThrown', p => errors.push('[exception] ' + (p.exceptionDetails && p.exceptionDetails.text) + ' ' +
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description || '')));
    client.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') errors.push('[console.error] ' + (p.args || []).map(a => a.value || a.description).join(' '));
    });
    let loaded = false;
    client.on('Page.loadEventFired', () => { loaded = true; });

    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    for (let i = 0; i < 60 && !loaded; i++) await sleep(250);
    await sleep(1200);

    const evalJs = async (expr, userGesture) => {
      const r = await client.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!userGesture,
      });
      if (r.exceptionDetails) throw new Error('页面求值异常: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
      return r.result && r.result.value;
    };

    console.log('\n=== 1. 页面加载与 WebGL 初始化 ===');
    /* 注意：不能用 body.textContent 找「无法初始化 WebGL」—— 那串文案本身就写在
       内联 <script> 里，而 textContent 会把 script 的文本一并算进去，必然误报。
       initGL 失败的真正后果是 document.body.innerHTML 被整体替换，#game 随之消失。 */
    const gl = await evalJs(`(() => {
      const c = document.getElementById('game');
      const g = c && (c.getContext('webgl') || c.getContext('experimental-webgl'));
      return { survived: !!c && !!document.getElementById('topbar'),
               canvas: !!c, w: c && c.width, h: c && c.height, gl: !!g,
               err: c && c.getContext('webgl') ? c.getContext('webgl').getError() : null };
    })()`);
    ok(gl.survived === true, 'initGL 成功后 DOM 未被错误页替换（#game/#topbar 仍在）', gl);
    ok(gl.gl === true, 'WebGL 上下文可用');
    ok(gl.w > 0 && gl.h > 0, '渲染画布已按视口尺寸初始化', { w: gl.w, h: gl.h });

    /* 开场说明必须讲清「授权只弹一次」和 file:// 的坑 —— 用户踩的就是这个 */
    const intro = await evalJs(`(() => {
      const t = document.getElementById('startScreen').textContent;
      return { once: /弹一次|不再重复询问/.test(t), file: /file:\\/\\//.test(t), fallback: /指令面板|文本输入/.test(t) };
    })()`);
    ok(intro.once === true, '开场说明写明了「授权只弹一次」');
    ok(intro.file === true, '开场说明写了 file:// 授权不持久化的提醒');
    ok(intro.fallback === true, '开场说明保留 Q / T 降级指引');
    /* 滚到底再拍：新增的音效 / 语音文案都在卡片折叠区下方，顶部视图看不到。
       注意滚动容器是 .card（overflow-y:auto），不是 .overlay。 */
    await evalJs(`(() => { const c = document.querySelector('#startScreen .card');
      if (c) { c.scrollTop = c.scrollHeight; } return 1; })()`);
    await sleep(250);
    const introShot = (await client.send('Page.captureScreenshot', { format: 'png' })).data;
    fs.writeFileSync(path.join(outDir, 'probe_start.png'), Buffer.from(introShot, 'base64'));
    console.log('  截图 → shots/probe_start.png');

    console.log('\n=== 2. 点击「开始任务」后音频上下文真的建立 ===');
    await evalJs(`document.getElementById('btnStart').click()`, true);
    await sleep(1500);
    const st = await evalJs(`JSON.stringify({
      hasSound: typeof Sound !== 'undefined',
      ok: Sound.ok, failed: Sound.failed,
      ctx: !!Sound.ctx, state: Sound.ctx && Sound.ctx.state,
      rate: Sound.ctx && Sound.ctx.sampleRate,
      pan: Sound.pan,
      amb: !!Sound.ambNodes,
      engines: Sound.engines.length,
      vol: Sound.vol, muted: Sound.muted,
      synCount: Object.keys(SYN).length,
      slider: document.getElementById('volRange').value,
      muteLabel: document.getElementById('btnMute').textContent,
    })`);
    const S = JSON.parse(st);
    ok(S.hasSound === true, '页面里存在 Sound 引擎');
    ok(S.ok === true, '用户手势后 Sound.ok 为 true（AudioContext 创建成功）', { ok: S.ok, failed: S.failed });
    ok(S.ctx === true, 'AudioContext 已创建');
    ok(S.rate > 0, 'AudioContext 就绪（sampleRate 正常）', S.rate);
    ok(S.pan === true, '支持立体声声像（createStereoPanner）');
    ok(S.amb === true, '环境音底噪已建立');
    ok(S.engines === 4, '4 路车辆引擎循环声已建立', S.engines);
    ok(S.synCount >= 43, '音色表条目数正常（含 8 个爆炸音色）', S.synCount);
    ok(String(S.slider) === String(Math.round(S.vol * 100)), '音量滑块与 Sound.vol 同步', { slider: S.slider, vol: S.vol });
    ok(/音效|静音/.test(S.muteLabel), '静音按钮文案正常', S.muteLabel);

    console.log('\n=== 3. 爆炸族音效真的合成出节点（而不是被静默吞掉）===');
    const synth = await evalJs(`(() => {
      const ctx = Sound.ctx;
      let osc = 0, nz = 0;
      const _co = ctx.createOscillator.bind(ctx), _cb = ctx.createBufferSource.bind(ctx);
      ctx.createOscillator = () => { osc++; return _co(); };
      ctx.createBufferSource = () => { nz++; return _cb(); };
      const ids = ['explosion','mine','barrel','grenade','rocketBoom','shellBoom','vehicleBoom','cannon'];
      const out = {};
      const px = World.player.x, py = World.player.y;
      for (const id of ids) {
        Sound.last = {}; Sound.budget = [];
        const o0 = osc, n0 = nz;
        try { sfx(id, px + 40, py + 10, { force: true }); out[id] = { osc: osc - o0, nz: nz - n0 }; }
        catch (e) { out[id] = { err: String(e) }; }
      }
      /* 对照：一个不存在的 id 必须零节点 */
      Sound.last = {}; Sound.budget = [];
      const o1 = osc, n1 = nz;
      sfx('__nope__', px, py, { force: true });
      out.__nope__ = { osc: osc - o1, nz: nz - n1 };
      ctx.createOscillator = _co; ctx.createBufferSource = _cb;
      return JSON.stringify(out);
    })()`, true);
    const SY = JSON.parse(synth);
    for (const id of ['explosion', 'mine', 'barrel', 'grenade', 'rocketBoom', 'shellBoom', 'vehicleBoom', 'cannon']) {
      const r = SY[id] || {};
      ok(!r.err && (r.osc > 0), 'sfx("' + id + '") 合成出振荡器节点', r);
    }
    ok((SY.__nope__.osc + SY.__nope__.nz) === 0, '未知 id 不产生任何节点（安全忽略）');

    console.log('\n=== 4. 静音 / 音量控件 ===');
    /* AudioParam 的 setTargetAtTime 是指数逼近，紧接着同步读 .value 读到的还是旧值，
       必须真的跑几十帧让音频线程把增益拉过去，否则测的是时序而不是行为。 */
    const waitFrames = n => evalJs(`new Promise(res => { let i = 0;
      const tick = () => { i++; i >= ${n} ? res(1) : requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })`, true);
    const readSnd = async () => JSON.parse(await evalJs(`JSON.stringify({
      vol: Sound.vol, muted: Sound.muted,
      label: document.getElementById('btnMute').textContent,
      gain: Sound.master.gain.value,
      slider: +document.getElementById('volRange').value,
      ls: localStorage.getItem('va.sound') || '',
    })`));

    const s0 = await readSnd();
    ok(s0.muted === false, '初始未静音', s0);
    ok(s0.slider === Math.round(s0.vol * 100), '初始滑块与 Sound.vol 同步', s0);

    await evalJs(`document.getElementById('btnMute').click()`, true);
    await waitFrames(40);
    const s1 = await readSnd();
    ok(s1.muted === true, '点静音后 Sound.muted 为 true');
    ok(s1.label === '静音', '静音按钮文案切换为「静音」', s1.label);
    ok(s1.gain < 0.01, '静音后 master 增益实际收敛到 0', s1.gain);
    ok(/"m":true/.test(s1.ls), '静音偏好已写入 localStorage', s1.ls);

    await evalJs(`document.getElementById('btnMute').click()`, true);
    await waitFrames(40);
    const s2 = await readSnd();
    ok(s2.muted === false && s2.label === '音效 ON', '再次点击恢复有声', s2);
    ok(Math.abs(s2.gain - s2.vol) < 0.02, '取消静音后 master 增益回到音量值', s2.gain);

    await evalJs(`(() => { const r = document.getElementById('volRange');
      r.value = 30; r.dispatchEvent(new Event('input', { bubbles: true })); })()`, true);
    await waitFrames(20);
    const s3 = await readSnd();
    ok(Math.abs(s3.vol - 0.30) < 1e-6, '拖动滑块把音量设为 0.30', s3.vol);
    ok(s3.muted === false, '拖滑块不会把自己静音');
    ok(/"v":0\.3/.test(s3.ls), '音量偏好已持久化', s3.ls);
    /* 静音状态下拖滑块 = 想听声音：应自动解除静音 */
    await evalJs(`document.getElementById('btnMute').click();`, true);
    await evalJs(`(() => { const r = document.getElementById('volRange');
      r.value = 55; r.dispatchEvent(new Event('input', { bubbles: true })); })()`, true);
    await waitFrames(20);
    const s4 = await readSnd();
    ok(s4.muted === false, '静音状态下拖动滑块自动解除静音', s4);
    ok(Math.abs(s4.vol - 0.55) < 1e-6, '音量更新为 0.55', s4.vol);

    console.log('\n=== 5. 真实战斗推进 5 秒（音频每帧更新不抛异常）===');
    await evalJs(`document.getElementById('dpDone') && document.getElementById('dpDone').click()`, true);
    await sleep(400);
    await evalJs(`document.getElementById('mSpeedUp').click()`, true);
    await sleep(5000);
    const runtime = await evalJs(`JSON.stringify({
      t: World.t, started: World.started, over: World.over,
      units: World.units.length, veh: World.vehicles.length,
      ok: Sound.ok, ctxState: Sound.ctx && Sound.ctx.state,
      engines: Sound.engines.length,
      unmuted: !Sound.muted,
    })`);
    const R = JSON.parse(runtime);
    ok(R.t > 0, '战场时间在推进', R.t);
    ok(R.ok === true, '战斗中音频引擎仍可用');
    ok(R.units > 0 && R.veh > 0, '战场单位与车辆正常', { units: R.units, veh: R.veh });

    const shotB64 = (await client.send('Page.captureScreenshot', { format: 'png' })).data;
    fs.writeFileSync(path.join(outDir, 'probe_browser.png'), Buffer.from(shotB64, 'base64'));
    console.log('  截图 → shots/probe_browser.png');

    console.log('\n=== 6. 页面错误汇总 ===');
    const fatal = errors.filter(e => !/favicon|ERR_FILE_NOT_FOUND|net::/i.test(e));
    ok(fatal.length === 0, '运行期无未捕获异常 / console.error', fatal.slice(0, 8));
    if (fatal.length) fatal.slice(0, 10).forEach(e => console.log('    ' + e));

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } catch (e) {
    fail++; console.log('\n  ✗ 探针执行失败: ' + e.message);
  } finally {
    try { client && client.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    await sleep(300);
    process.exit(fail ? 1 : 0);
  }
})();
