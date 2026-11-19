// Headless smoke test: renders the built app and checks the main screens.
// Usage: node tests/smoke.mjs http://localhost:5173 [outdir]
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:5173', out = process.argv[3] || '/tmp';
const exe = process.env.CHROME || '/usr/bin/google-chrome';
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
async function page(w, h, mobile) {
  const p = await b.newPage({ viewport: { width: w, height: h }, isMobile: !!mobile, hasTouch: !!mobile });
  p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
const ready = (p) => p.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-loading') && window.__sepur?.frames > 2, null, { timeout: 40000 });
const kai = (p) => p.waitForFunction(() => document.querySelector('#app').dataset.kai === 'ok', null, { timeout: 40000 });
const T = '#t=0730&d=2026-11-19';

// desktop home + animation
let p = await page(1400, 900);
await p.goto(base + '/' + T); await ready(p); await kai(p);
await p.waitForTimeout(1500);
const now = await p.textContent('.now .v');
check(/^\d+ kereta/.test(now) && parseInt(now) > 200, 'home shows running trains: ' + now.trim());
const f1 = await p.evaluate(() => window.__sepur.frames); await p.waitForTimeout(2000);
const st = await p.evaluate(() => window.__sepur);
check(st.frames - f1 > 20, `animation loop runs (${st.frames - f1} frames in 2 s, cap ${st.fpsCap} fps, ${st.frameCost} ms/frame, ${st.trains} trains)`);
check((await p.$$('[data-filter="kai"]')).length === 1 && parseInt(await p.textContent('[data-filter="kai"] b')) > 10, 'intercity trains running (GAPEKA)');
await p.screenshot({ path: `${out}/desk-home.png` });

// station detail and full-day timetable
await p.click('[data-open="station:MRI"]'); await p.waitForTimeout(1500);
check((await p.textContent('#ptitle')).includes('Manggarai'), 'station detail opens');
check((await p.$$('.board .row')).length > 5, 'station board lists departures');
check(/#station=MRI/.test(p.url()), 'URL hash has station');
await p.click('[data-act="full"]'); await p.waitForTimeout(800);
const nT = (await p.$$('.times .tbtn')).length;
check(nT > 300, `full-day station timetable (${nT} stops)`);
await p.click('[data-ttdate="2026-11-21"]'); await p.waitForTimeout(600);
check((await p.textContent('.dpick .badge')).includes('Akhir pekan'), 'date picker switches to weekend timetable');
await p.screenshot({ path: `${out}/desk-station-full.png` });
await p.click('[data-act="full-off"]'); await p.waitForTimeout(400);

// train detail with ETA
await p.click('.board .row'); await p.waitForTimeout(1500);
check(!!(await p.$('#train-status')), 'train detail opens');
check((await p.$$('#train-stops .stop')).length > 2, 'train detail lists stops');
check(/dalam/.test(await p.textContent('#train-stops')), 'train detail shows ETA countdowns');
await p.screenshot({ path: `${out}/desk-train.png` });
await p.goBack(); await p.waitForTimeout(800);
check((await p.textContent('#ptitle')).includes('Manggarai'), 'browser back returns to station');

// lines + line timetable grid
await p.click('.phead [data-act="back"]'); await p.waitForTimeout(400);
await p.click('[data-tab="jalur"]'); await p.waitForTimeout(600);
check((await p.$$('[data-open^="line:"]')).length > 100, 'Jalur tab lists urban and intercity lines');
await p.click('[data-open="line:krl-b"]'); await p.waitForTimeout(1500);
const cells = await p.$$eval('.tt tbody td', (t) => t.filter((x) => /\d\d\.\d\d/.test(x.textContent)).length);
check(cells > 100, `line timetable grid (${cells} times)`);
await p.click('[data-ttdir="1"]'); await p.waitForTimeout(500);
check((await p.$$('.tt thead th')).length > 3, 'grid direction toggle');
await p.screenshot({ path: `${out}/desk-line.png` });
await p.click('.phead [data-act="back"]'); await p.waitForTimeout(300);
await p.click('[data-open="line:mrt-ns"]'); await p.waitForTimeout(1200);
check((await p.textContent('.note')).includes('ShioriLabs'), 'MRT line cites its real timetable source');
await p.click('.phead [data-act="back"]'); await p.waitForTimeout(300);
await p.click('[data-open="line:kcic"]'); await p.waitForTimeout(1200);
check((await p.textContent('.note')).includes('Perkiraan'), 'Whoosh is labelled as estimate');

// search
await p.click('.phead [data-act="back"]'); await p.click('[data-tab="peta"]'); await p.fill('#q', 'bogor'); await p.waitForTimeout(800);
check((await p.$$('[data-open^="station:"]')).length > 0 && (await p.$$('[data-open^="line:"]')).length > 0, 'search finds stations and lines');
await p.fill('#q', '1000'); await p.waitForTimeout(500);
check((await p.$$('[data-open^="train:1000:"]')).length > 0, 'search finds train number 1000');
await p.fill('#q', 'argo semeru'); await p.waitForTimeout(500);
check((await p.$$('[data-open^="line:g-"]')).length > 0, 'search finds intercity train names');
await p.fill('#q', '');

// trip planner
await p.click('[data-tab="rute"]'); await p.waitForTimeout(500);
await p.fill('#pick-q', 'bogor'); await p.waitForTimeout(300); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
await p.fill('#pick-q', 'bandara soekarno'); await p.waitForTimeout(300);
await p.click('[data-setplace="BST"]'); await p.waitForTimeout(1500);
const nj = (await p.$$('#plan-res .jrow')).length;
check(nj >= 2, `planner finds Bogor → Bandara journeys (${nj})`);
check(/pindah/.test(await p.textContent('#plan-res')), 'planner shows transfers');
await p.screenshot({ path: `${out}/desk-plan.png` });
await p.click('#plan-res .jrow'); await p.waitForTimeout(1200);
check((await p.$$('.legs .leg')).length >= 2 && /tunggu/.test(await p.textContent('.legs')), 'journey detail shows legs and waits');
await p.click('[data-act="j-sim"]'); await p.waitForTimeout(2500);
check(!(await p.$eval('#simbar', (e) => e.hidden)), 'journey simulation runs with time bar');
await p.screenshot({ path: `${out}/desk-journey-sim.png` });
await p.click('[data-act="sim-stop"]'); await p.waitForTimeout(300);
// intercity planner via URL
await p.goto(base + '/#tab=rute&from=GMR&to=SGU&pd=2026-11-19&pt=0600'); await p.reload(); await ready(p); await kai(p); await p.waitForTimeout(1500);
const ic = await p.textContent('#view');
check((await p.$$('#plan-res .jrow')).length >= 1 && /Gambir/.test(ic), 'planner: Gambir → Surabaya Gubeng by intercity');
await p.screenshot({ path: `${out}/desk-plan-ic.png` });
// train card on click
const clickTrain = async (pg, id, z, tap) => {
  await pg.evaluate(([id, z]) => { const { E, clock } = window.__sepurDebug; const f = E.find(id, clock()); window.__map.jumpTo({ center: E.state(f.trip, f.t).p, zoom: z }); }, [id, z]);
  await pg.waitForTimeout(1500);
  const pt = await pg.evaluate((id) => { const { E, clock } = window.__sepurDebug; const f = E.find(id, clock()); const q = window.__map.project(E.state(f.trip, f.t).p); const r = window.__map.getCanvas().getBoundingClientRect(); return [q.x + r.left, q.y + r.top]; }, id);
  if (tap) await pg.touchscreen.tap(pt[0], pt[1]); else await pg.mouse.click(pt[0], pt[1]);
  await pg.waitForTimeout(1200);
  return (await pg.$('#tcard')) ? pg.textContent('#tcard') : '';
};
await p.goto(base + '/#t=1000&d=2026-11-19'); await p.reload(); await ready(p); await kai(p); await p.waitForTimeout(1000);
const ct = await clickTrain(p, 'KA 5', 12.5);
check(/Argo Semeru/.test(ct) && /Tujuan/i.test(ct) && /Gambir/.test(ct) && /Berikutnya/.test(ct), 'click on train shows card with name and destination');
await p.waitForFunction(() => document.querySelector('#tcard img.thumb')?.naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});
check(await p.evaluate(() => document.querySelector('#tcard img.thumb')?.naturalWidth > 0) && /ilustrasi/i.test(ct) && /CC BY-SA|CC0|CC BY/.test(ct), 'card shows rolling-stock image with credit + licence');
check(/Kecepatan/.test(ct) && /≈ \d+ km\/j/.test(ct) && /bukan GPS/.test(ct), 'card shows estimated speed, labelled as estimate');
await p.click('#tcard [data-open]'); await p.waitForTimeout(1000);
check(await p.evaluate(() => document.querySelectorAll('.spchart svg polyline').length === 1 && /km\/j/.test(document.querySelector('.spdf').textContent)), 'train detail shows speed facts and chart');
check(await p.evaluate(() => /commons\.wikimedia\.org/.test(document.querySelector('.fleet.big a')?.href || '')), 'detail image links to its Commons source');
check(!(await p.$('#tcard')) && /Argo Semeru/.test(await p.textContent('.dhead')) && /Tujuan/.test(await p.textContent('.facts')), 'card "Detail lengkap" opens train detail');
await p.goto(base + '/#t=1000&d=2026-11-19'); await p.reload(); await ready(p); await kai(p);
await p.fill('#q', 'taksaka'); await p.waitForTimeout(500);
check(/Taksaka · KA \d+/.test(await p.textContent('#view')), 'search finds trains by name (taksaka)');
check(p.errors.length === 0, 'no page errors on desktop ' + p.errors.join('; '));

// night: urban trains asleep, overnight intercity runs
const n = await page(1400, 900);
await n.goto(base + '/#t=0230&d=2026-11-19'); await ready(n); await kai(n); await n.waitForTimeout(1000);
check((await n.textContent('[data-filter="krl"] b')) === '0' && parseInt(await n.textContent('[data-filter="kai"] b')) > 0, 'night: no KRL, overnight intercity still running');

// mobile
const m = await page(390, 844, true);
await m.goto(base + '/#t=0800&d=2026-11-19'); await ready(m); await m.waitForTimeout(1500);
await m.screenshot({ path: `${out}/mob-home.png` });
await m.goto(base + '/#train=1000&td=2026-11-19&t=0520&d=2026-11-19'); await m.reload(); await ready(m); await m.waitForTimeout(2500);
check((await m.textContent('#view')).includes('KA 1000'), 'deep link #train=1000 opens on mobile');
await m.goto(base + '/#t=0520&d=2026-11-19'); await m.reload(); await ready(m); await m.waitForTimeout(1000);
const mc = await clickTrain(m, '1000', 13.5, true);
check(/Commuter Line Bogor/.test(mc) && /Bogor/.test(mc), 'mobile tap on train shows card');
const box = await m.$eval('#tcard', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
check(box[0] >= 0 && box[1] <= 390, 'mobile card fits the screen ' + box.map(Math.round));
check(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile: no horizontal overflow');

await m.screenshot({ path: `${out}/mob-train.png` });
await m.goto(base + '/#tab=rute&from=THB&to=BKS&pd=2026-11-19&pt=0800&t=0800&d=2026-11-19'); await m.reload(); await ready(m); await m.waitForTimeout(2000);
check((await m.$$('#plan-res .jrow')).length >= 1, 'mobile planner deep link');
await m.screenshot({ path: `${out}/mob-plan.png` });
check(m.errors.length === 0, 'no page errors on mobile ' + m.errors.join('; '));
await b.close();
console.log(fail ? `${fail} failed` : 'all smoke checks passed');
process.exit(fail ? 1 : 0);
