/* 语音授权流程验证（真实浏览器 + CDP）—— 精确复现并验证「按 V 反复弹授权框」这个 bug。

   原 bug 的机制：
     按住 V → recog.start() → Chrome 弹出麦克风授权框 → 玩家要松手去点「允许」→
     keyup 调 stopVoice() → recog.stop() 把这次「待授权」的会话一并中止，授权随之作废 →
     再按 V 又发起全新请求，又弹框 → 永远进不去。

   要验证的三件事：
     A. 正常按住说话：getUserMedia 只请求一次，授权成功后确实 start()
     B. ★核心★ 授权请求进行中就松手：授权不能作废（独立于识别会话），
        且之后按 V 不会再次请求授权（不再弹框）
     C. 授权被拒后：不再反复触发请求（不会陷入弹框循环）

   用 --use-fake-ui-for-media-stream 让浏览器自动同意授权（等价于玩家点了「允许」），
   --use-fake-device-for-media-stream 提供虚拟麦克风。
   用法: node voice_flow.js */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge/Chrome'); process.exit(2); }

const root = path.join(__dirname, '..');
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'va-flow-'));
const PORT = 9500 + (process.pid % 400);

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m + (x !== undefined ? '   ' + JSON.stringify(x) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files', '--no-sandbox', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: 'ignore' });

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map(); let id = 0; const handlers = {};
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method && handlers[m.method]) handlers[m.method](m.params);
    });
    ws.addEventListener('error', () => reject(new Error('WS error')));
    ws.addEventListener('open', () => resolve({
      on: (k, f) => { handlers[k] = f; },
      send: (method, params) => new Promise((res, rej) => {
        const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      }),
      close: () => ws.close(),
    }));
  });
}
async function waitTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(250);
  }
  throw new Error('CDP 端口未就绪');
}

(async () => {
  let client = null;
  try {
    client = await cdpConnect(await waitTarget());
    let loaded = false;
    client.on('Page.loadEventFired', () => { loaded = true; });
    const pageErrors = [];
    client.on('Runtime.exceptionThrown', p => pageErrors.push(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) ||
      (p.exceptionDetails && p.exceptionDetails.text) || '?'));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    for (let i = 0; i < 60 && !loaded; i++) await sleep(200);
    await sleep(1200);

    const ev = async (expr, gesture) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!gesture });
      if (r.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result && r.result.value;
    };

    /* 进入可下令状态 + 埋点：统计 getUserMedia / recog.start 的实际调用次数 */
    await ev(`document.getElementById('btnStart').click()`, true);
    await sleep(600);
    await ev(`document.getElementById('dpDone') && document.getElementById('dpDone').click()`, true);
    await sleep(300);

    const instrument = `(() => {
      window.__gum = 0; window.__start = 0; window.__rej = 0; window.__ev = [];
      const md = navigator.mediaDevices;
      if (!window.__origGum) window.__origGum = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => { window.__gum++; return window.__origGum(c); };
      if (!Mic.__origStart) Mic.__origStart = Mic.recog.start.bind(Mic.recog);
      Mic.recog.__origStart = Mic.__origStart;
      Mic.recog.start = () => { window.__start++; return Mic.__origStart(); };
      /* 识别事件日志：headless 下识别服务常常不可用，靠它区分「代码错」与「环境不支持」 */
      ['start', 'error', 'end', 'result'].forEach(n => {
        const o = Mic.recog['on' + n];
        Mic.recog['on' + n] = (a) => { window.__ev.push(n + (a && a.error ? '(' + a.error + ')' : '')); return o && o(a); };
      });
      return 1;
    })()`;
    await ev(instrument, true);

    const snap = async () => JSON.parse(await ev(`JSON.stringify({
      gum: window.__gum, start: window.__start, rej: window.__rej,
      perm: Mic.perm, holding: Mic.holding, listening: Mic.listening, starting: Mic.starting,
      hasStream: !!Mic.stream, ok: Mic.ok,
      label: document.getElementById('btnVoice').textContent,
      micClass: document.getElementById('mic').className,
      ev: (window.__ev || []).slice(-6).join(','),
    })`));

    const keydown = () => ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' })); 1`, true);
    const keyup = () => ev(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'v' })); 1`, true);
    const resetMic = (p) => ev(`(() => { Mic.perm = '${p}'; Mic.stream = null;
      window.__ev = [];
      Mic.listening = false; Mic.starting = false; Mic.holding = false; return 1; })()`, true);

    console.log('\n=== A. 正常「按住 V 说话」 ===');
    const a0 = await snap();
    ok(a0.ok === true, 'SpeechRecognition 可用', a0);
    await keydown();
    await sleep(900);
    const a1 = await snap();
    ok(a1.gum === 1, 'getUserMedia 被调用 1 次', a1.gum);
    ok(a1.perm === 'granted', '授权状态为 granted', a1.perm);
    ok(a1.hasStream === true, '已持有 MediaStream（保留不放，后续不再弹窗）');
    ok(a1.start >= 1, '授权成功后真的调用了 recog.start()', a1.start);
    await keyup();
    await sleep(300);
    const a2 = await snap();
    ok(a2.holding === false, '松手后 holding 复位');

    console.log('\n=== A2. 再次按住 V —— 不应重复请求授权（原 bug 的弹框就在这里）===');
    await keydown();
    await sleep(700);
    const a3 = await snap();
    ok(a3.gum === 1, '第二次按 V 没有再次调用 getUserMedia（不再弹授权框）', a3.gum);
    ok(a3.start >= 2, '第二次按 V 直接 start()', { start: a3.start, ev: a3.ev, perm: a3.perm, listening: a3.listening, starting: a3.starting });
    await keyup();
    await sleep(200);

    console.log('\n=== B. ★核心★ 授权请求尚未返回时就松手 ===');
    await resetMic('unknown');
    await ev(`window.__gum = 0; window.__start = 0; 1`, true);
    /* 同一次求值里按下并立刻松开：此刻 getUserMedia 的 promise 还在飞 */
    await ev(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'v' }));
      return 1; })()`, true);
    await sleep(1000);
    const b1 = await snap();
    ok(b1.perm === 'granted', '★ 松手没有作废授权（授权独立于识别会话）', b1);
    ok(b1.hasStream === true, '★ 授权期间松手，MediaStream 仍然拿到并保留');
    ok(b1.start === 0, '授权期间松手 → 不强行开麦（不会录进废话）', b1.start);
    /* 授权已落地，再按 V 应当直接开麦，且不再请求授权 */
    await keydown();
    await sleep(700);
    const b2 = await snap();
    ok(b2.gum === 1, '★ 授权后再次按 V 未重复请求授权（弹框不再出现）', b2.gum);
    ok(b2.start >= 1, '授权后按 V 正常开麦', b2.start);
    await keyup();
    await sleep(200);

    console.log('\n=== C. 授权被拒后不得反复触发请求 ===');
    await resetMic('unknown');
    await ev(`(() => {
      window.__gum = 0; window.__start = 0; window.__rej = 0;
      navigator.mediaDevices.getUserMedia = () => {
        window.__rej++;
        return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      };
      return 1; })()`, true);
    await keydown(); await sleep(400); await keyup();
    await sleep(300);
    const c1 = await snap();
    ok(c1.perm === 'denied', '拒绝后状态记为 denied', c1.perm);
    ok(c1.rej === 1, '拒绝后只请求了 1 次', c1.rej);
    for (let i = 0; i < 4; i++) { await keydown(); await sleep(150); await keyup(); await sleep(120); }
    const c2 = await snap();
    ok(c2.rej === 1, '★ 之后连按 4 次 V，未再触发任何授权请求（不会陷入弹框循环）', c2.rej);
    ok(c2.start === 0, '未授权时不尝试开麦', c2.start);
    ok(/未授权|重试/.test(c2.label), '按钮文案提示未授权/可重试', c2.label);
    ok(/warn/.test(c2.micClass), '状态圆点切到 warn 样式', c2.micClass);

    console.log('\n=== D. 运行期无未捕获异常 ===');
    const fatal = pageErrors.filter(e => !/favicon|net::/i.test(e));
    ok(fatal.length === 0, '无未捕获异常', fatal.slice(0, 5));

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
