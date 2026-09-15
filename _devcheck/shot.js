/* 用 Playwright 真的打开 index.html 跑一遍并截图：
   这是唯一能验证「画面是否正确渲染」的手段 —— 语法检查与 Node 桩都看不到像素。
   同时收集 console 错误 / 未捕获异常。 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/lujiajing/.workbuddy/binaries/node/workspace/node_modules/playwright');

const root = path.join(__dirname, '..');
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/');
const outDir = path.join(__dirname, 'shots');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
const log = [];
const shot = async (page, name) => {
  const p = path.join(outDir, name + '.png');
  await page.screenshot({ path: p });
  log.push('  截图 → shots/' + name + '.png');
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox', '--no-sandbox', '--disable-frame-rate-limit',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [], warns = [];
  page.on('console', m => {
    const t = m.type();
    if (t === 'error') errors.push('[console.error] ' + m.text());
    else if (t === 'warning') warns.push('[warn] ' + m.text());
    else if (m.text().startsWith('着色器') || m.text().startsWith('链接')) errors.push('[log] ' + m.text());
  });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  /* ① 开场菜单 */
  await shot(page, '01_start');

  /* WebGL 是否真的初始化成功？失败了页面会被替换成提示文案 */
  const webglOk = await page.evaluate(() => !document.body.textContent.includes('无法初始化 WebGL'));
  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById('game');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { ok: false };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true, w: c.width, h: c.height,
      renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
  log.push('WebGL 初始化: ' + (webglOk ? '成功' : '失败'));
  log.push('canvas: ' + JSON.stringify(canvasInfo));

  /* ② 进入部署（俯视部署视图） */
  await page.click('#btnStart');
  await page.waitForTimeout(1200);
  await shot(page, '02_deploy');

  /* ③ 结束部署 → 第一人称潜伏 */
  await page.click('#dpDone');
  await page.waitForTimeout(1200);
  await shot(page, '03_fps_sunny');

  /* ④ 观察帧率（软件渲染下很慢，用来说明时间推进） */
  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }));
  log.push('软件渲染帧率: ' + fps + ' fps');

  /* ⑤ 加速并等待车队进入视野 */
  await page.click('#mSpeedUp'); await page.waitForTimeout(200);
  await page.click('#mSpeedUp'); await page.waitForTimeout(200);
  await page.waitForTimeout(14000);
  await shot(page, '04_convoy');

  /* ⑥ 起爆地雷 → 伏击开始 */
  await page.keyboard.press('f');
  await page.waitForTimeout(9000);
  await shot(page, '05_ambush');

  /* ⑦ 开火 + 移动 */
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(3500);
  await page.mouse.up();
  await shot(page, '06_firefight');

  /* ⑧ 打开指令面板 */
  await page.keyboard.press('q');
  await page.waitForTimeout(1000);
  await shot(page, '07_cmdpanel');

  /* ⑨ 战场总览（文字状态，用来看逻辑是否在推进） */
  const hud = await page.evaluate(() => ({
    time: document.getElementById('mTime').textContent,
    phase: document.getElementById('mPhase').textContent,
    alive: document.getElementById('mAlive').textContent,
    kill: document.getElementById('mKill').textContent,
    mag: document.getElementById('magAmmo').textContent,
    reserve: document.getElementById('reserveAmmo').textContent,
    weapon: document.getElementById('weaponName').textContent,
    objectives: document.getElementById('objList').textContent.slice(0, 120),
    subs: document.getElementById('subs').textContent.slice(0, 160),
    killfeed: document.getElementById('killfeed').textContent.slice(0, 120),
  }));
  log.push('HUD 状态: ' + JSON.stringify(hud, null, 0));

  /* 注意：await browser.close() 在 SwiftShader 下偶发永不返回，直接进程退出 */
  browser.close().catch(() => { });
  console.log(log.join('\n'));
  if (errors.length) {
    console.log('\n=== 页面错误 (' + errors.length + ') ===');
    errors.slice(0, 20).forEach(e => console.log('  ' + e));
    process.exit(1);
  }
  console.log('\n无页面错误 ✔');
  process.exit(0);
})().catch(e => { console.error('截图脚本失败: ' + e.message + '\n' + (e.stack || '')); process.exit(1); });
