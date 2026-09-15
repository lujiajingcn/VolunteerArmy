/* 实测「file:// 页面到底能不能拿到麦克风授权」：
   同一份 index.html，分别在 file:// 与 http://127.0.0.1 下调用 getUserMedia 与
   SpeechRecognition，比较结果。这是判断「语音修不好到底是代码问题还是协议问题」的唯一硬证据。

   用 --use-fake-ui-for-media-stream 让浏览器自动同意授权（等价于用户点了「允许」），
   用 --use-fake-device-for-media-stream 提供虚拟麦克风（headless 没有真实输入设备）。
   于是：如果 file:// 下仍然失败，就说明失败原因不是「用户没点允许」，而是协议本身被拦。
   用法: node voice_probe.js */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge/Chrome'); process.exit(2); }

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'va-voice-'));
const PORT_WEB = 9411, PORT_CDP = 9412;

/* 起一个只读静态服务器（仅绑 127.0.0.1） */
const server = http.createServer((req, res) => {
  const p = path.join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url).replace(/^\//, ''));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end('nope'); }
  const ext = path.extname(p);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

const child = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-fake-ui-for-media-stream',          // 自动同意授权弹窗
  '--use-fake-device-for-media-stream',      // 虚拟麦克风
  '--autoplay-policy=no-user-gesture-required',
  '--no-sandbox', '--disable-gpu-sandbox',
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
      const list = await (await fetch('http://127.0.0.1:' + PORT_CDP + '/json/list')).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { }
    await sleep(250);
  }
  throw new Error('CDP 端口未就绪');
}

/* 在页面里探测：媒体设备可用性 + getUserMedia + SpeechRecognition 可用性 */
const PROBE = `(async () => {
  const out = { proto: location.protocol, secure: window.isSecureContext,
                hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
  out.hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  if (out.hasMediaDevices) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          out.gum = 'granted'; out.tracks = s.getAudioTracks().length;
          out.label = (s.getAudioTracks()[0] || {}).label || ''; window.__s = s; }
    catch (e) { out.gum = 'ERROR ' + e.name + ': ' + e.message; }
  }
  if (navigator.permissions && navigator.permissions.query) {
    try { const st = await navigator.permissions.query({ name: 'microphone' }); out.permState = st.state; }
    catch (e) { out.permState = 'query-failed:' + e.name; }
  }
  return JSON.stringify(out);
})()`;

(async () => {
  await new Promise(r => server.listen(PORT_WEB, '127.0.0.1', r));
  let client = null;
  const results = {};
  try {
    const wsUrl = await waitTarget();
    client = await cdpConnect(wsUrl);
    let loaded = false;
    client.on('Page.loadEventFired', () => { loaded = true; });
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const run = async (label, url) => {
      loaded = false;
      await client.send('Page.navigate', { url });
      for (let i = 0; i < 60 && !loaded; i++) await sleep(200);
      await sleep(600);
      /* 必须由用户手势触发（等价于点了一下页面） */
      const r = await client.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) { results[label] = { err: r.exceptionDetails.text }; return; }
      results[label] = JSON.parse(r.result.value);
    };

    await run('file', 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/'));
    await run('http', 'http://127.0.0.1:' + PORT_WEB + '/index.html');

    const pad = s => (s + '                ').slice(0, 16);
    console.log('\n=== getUserMedia 在两种协议下的实测结果 ===');
    for (const k of ['file', 'http']) {
      const R = results[k] || {};
      console.log('  ' + pad(R.proto || k) +
        ' secure=' + R.secure +
        '  mediaDevices=' + R.hasMediaDevices +
        '  SR=' + R.hasSR +
        '  permState=' + (R.permState || '-') +
        '  getUserMedia=' + (R.gum || '-') +
        (R.label ? '  dev=' + R.label : ''));
    }
    console.log('\n结论：' + (
      results.file && results.file.gum === 'granted' && results.http && results.http.gum === 'granted'
        ? 'file:// 与 http:// 都能拿到麦克风（授权问题不在协议）'
        : results.file && results.file.gum !== 'granted'
          ? 'file:// 下拿不到麦克风（即使自动同意授权也不行）→ 必须改用 http://127.0.0.1 打开'
          : '结果异常，见上表'
    ));
  } catch (e) {
    console.log('探针失败: ' + e.message);
  } finally {
    try { client && client.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    server.close();
    await sleep(300);
    process.exit(0);
  }
})();
