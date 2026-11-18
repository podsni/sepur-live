// Headless smoke test: renders the built app and checks the main screens.
// Usage: node tests/smoke.mjs http://localhost:5173 [outdir]
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:5173', out = process.argv[3] || '/tmp';
const exe = process.env.CHROME || '/usr/bin/google-chrome';
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
async function page(w, h) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
const T = '#t=0730&d=2026-11-19';
// desktop home
let p = await page(1400, 900);
await p.goto(base + '/' + T); await p.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-loading'), null, { timeout: 30000 });
await p.waitForTimeout(2500);
const now = await p.textContent('.now .v');
check(/^\d+ kereta/.test(now) && parseInt(now) > 50, 'home shows running trains: ' + now.trim());
const nTrains = await p.evaluate(() => document.querySelector('.maplibregl-canvas') ? 1 : 0);
check(nTrains === 1, 'map canvas rendered');
await p.screenshot({ path: `${out}/desk-home.png` });
// station detail via click on quick pill
await p.click('[data-open="station:MRI"]'); await p.waitForTimeout(1500);
check((await p.textContent('#ptitle')).includes('Manggarai'), 'station detail opens');
check((await p.$$('.board .row')).length > 5, 'station board lists departures');
check(/#station=MRI/.test(p.url()), 'URL hash has station');
await p.screenshot({ path: `${out}/desk-station.png` });
// train detail from board
await p.click('.board .row'); await p.waitForTimeout(1500);
check(!!(await p.$('#train-status')), 'train detail opens');
check((await p.$$('.stops .stop')).length > 2, 'train detail lists stops');
await p.screenshot({ path: `${out}/desk-train.png` });
// back, jalur tab, line detail
await p.goBack(); await p.waitForTimeout(800);
check((await p.textContent('#ptitle')).includes('Manggarai'), 'browser back returns to station');
await p.click('.phead [data-act="back"]'); await p.waitForTimeout(400);
await p.click('[data-tab="jalur"]'); await p.waitForTimeout(600);
check((await p.$$('[data-open^="line:"]')).length > 20, 'Jalur tab lists lines');
await p.click('[data-open="line:mrt-ns"]'); await p.waitForTimeout(1500);
check((await p.textContent('.note')).includes('Perkiraan'), 'MRT line is labelled as estimate');
await p.screenshot({ path: `${out}/desk-line.png` });
// search
await p.click('.phead [data-act="back"]'); await p.click('[data-tab="peta"]'); await p.fill('#q', 'bogor'); await p.waitForTimeout(800);
check((await p.$$('[data-open^="station:"]')).length > 0 && (await p.$$('[data-open^="line:"]')).length > 0, 'search finds stations and lines');
await p.fill('#q', '1000'); await p.waitForTimeout(500);
check((await p.$$('[data-open^="train:1000"]')).length > 0, 'search finds train number 1000');
// layers panel and 3D
await p.fill('#q', ''); await p.click('#b-layers'); await p.waitForTimeout(300);
check(!(await p.$eval('#layers', (e) => e.hidden)), 'layers panel opens');
await p.click('#b-layers'); await p.click('#b-3d'); await p.waitForTimeout(1500);
check((await p.getAttribute('#b-3d', 'aria-pressed')) === 'true', '3D toggles');
await p.screenshot({ path: `${out}/desk-3d.png` });
check(p.errors.length === 0, 'no page errors on desktop ' + p.errors.join('; '));
// night: nothing running
const n = await page(1400, 900);
await n.goto(base + '/#t=0230&d=2026-11-19'); await n.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-loading'), null, { timeout: 30000 });
await n.waitForTimeout(1000);
check((await n.textContent('.now .v')).startsWith('0 kereta') && (await n.textContent('.card')).includes('Kereta pertama'), 'night view shows first train');
// mobile sheet + deep link to a train
const m = await page(390, 844);
await m.goto(base + '/#t=0800&d=2026-11-19'); await m.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-loading'), null, { timeout: 30000 });
await m.waitForTimeout(2000);
await m.screenshot({ path: `${out}/mob-home.png` });
await m.goto(base + '/#train=1000&t=0520&d=2026-11-19'); await m.reload(); await m.waitForTimeout(3500);
check((await m.textContent('#view')).includes('KA 1000'), 'deep link #train=1000 opens on mobile');
await m.screenshot({ path: `${out}/mob-train.png` });
check(m.errors.length === 0, 'no page errors on mobile ' + m.errors.join('; '));
await b.close();
console.log(fail ? `${fail} failed` : 'all smoke checks passed');
process.exit(fail ? 1 : 0);
