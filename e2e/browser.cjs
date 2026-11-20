// Prova nel browser (opzionale, non fa parte di `npm test`): due utenti sulla stessa board.
// Serve Playwright con Chromium: `npm i --no-save playwright && npx playwright install chromium`,
// oppure PLAYWRIGHT_FROM=/percorso/di/un/package.json che lo contiene. Screenshot: SCREENSHOTS=/cartella
const { createRequire } = require('module');
const req = createRequire(process.env.PLAYWRIGHT_FROM || `${process.cwd()}/package.json`);
const { chromium } = req('playwright');
const OUT = process.env.SCREENSHOTS;
let BASE;
const slug = 'e2e-' + Date.now().toString(36);
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK   ' : 'FAIL ') + msg); if (!c) fails++; };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${who} console: ${m.text()}`); });
};

(async () => {
  const { createApp } = await import('../server/index.js');
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const A = await ctxA.newPage(); const B = await ctxB.newPage();
  watch(A, 'A'); watch(B, 'B');

  // 0. home: c'è il footer con help e privacy, e il modulo apre la board
  const H = await ctxA.newPage(); watch(H, 'H');
  await H.goto(`${BASE}/`); await H.waitForSelector('#home:not([hidden])');
  ok(await H.isVisible('.help summary:has-text("Come funziona")') && await H.isVisible('.help summary:has-text("Privacy e cookie")'), 'home: footer con help e privacy visibile');
  await H.click('summary:has-text("Privacy e cookie")');
  ok((await H.textContent('.help')).includes('non imposta cookie propri'), 'home: la nota privacy si apre');
  await H.close();

  // 1. profilo: Invio nei campi deve SALVARE (bug 1.0)
  await A.goto(`${BASE}/${slug}`);
  await A.waitForSelector('#dlg-profile[open]', { timeout: 5000 });
  ok(true, 'al primo accesso si apre il profilo');
  await A.fill('#form-profile [name=playerName]', 'Fede');
  await A.fill('#form-profile [name=characterName]', 'Aria');
  await A.evaluate(() => { const c = document.querySelector('#form-profile [name=color]'); c.value = '#ffee00'; });
  await A.press('#form-profile [name=characterName]', 'Enter');
  await A.waitForFunction(() => !document.querySelector('#dlg-profile').open);
  await A.waitForFunction((s) => localStorage.getItem('sword-tracker:profile:' + s) !== null, slug, { timeout: 3000 }).catch(() => {});
  const saved = await A.evaluate((s) => JSON.parse(localStorage.getItem('sword-tracker:profile:' + s)), slug);
  ok(saved && saved.characterName === 'Aria' && saved.playerName === 'Fede' && saved.color === '#ffee00', 'Invio salva il profilo (' + JSON.stringify(saved) + ')');

  // 2. + Il mio personaggio: non deve richiedere i dati
  await A.click('#btn-add-me');
  await A.waitForSelector('.slot[data-slot="0"] .token');
  ok(!(await A.evaluate(() => document.querySelector('#dlg-profile').open)), '+ Il mio personaggio non riapre il profilo');
  ok((await A.textContent('.slot[data-slot="0"] .token .label')).includes('Aria'), 'la targhetta Aria è nello slot 0');
  ok(await A.evaluate(() => document.querySelector('.token').classList.contains('light')), 'colore chiaro (#ffee00) -> testo nero (classe light)');

  // 3. sincronizzazione: B vede la targhetta
  await B.goto(`${BASE}/${slug}`);
  await B.waitForSelector('#dlg-profile[open]');
  await B.click('#form-profile button[data-close]');
  await B.waitForSelector('.slot[data-slot="0"] .token');
  ok(true, 'B vede Aria in tempo reale');

  // 4. +3 / -3
  await A.click('.token button:has-text("+3")');
  await B.waitForSelector('.slot[data-slot="3"] .token');
  ok(true, '+3 sposta Aria allo slot 3 (visto da B)');
  await A.click('.token button:has-text("−3")');
  await B.waitForSelector('.slot[data-slot="0"] .token');
  ok(true, '−3 la riporta allo slot 0');

  // 5. spunta ha già agito
  await A.check('.token .acted-box input');
  await B.waitForSelector('.token.acted');
  ok(true, 'la spunta è visibile a B (nome barrato)');

  // 6. Reset turn: clic veloce non fa nulla, pressione lunga sì
  const r = await A.locator('#btn-reset-turn').boundingBox();
  await A.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await A.mouse.down(); await A.waitForTimeout(250); await A.mouse.up();
  await A.waitForTimeout(500);
  ok(await B.evaluate(() => !!document.querySelector('.token.acted')), 'clic veloce su Reset turn NON azzera');
  await A.mouse.down(); await A.waitForTimeout(1500); await A.mouse.up();
  await B.waitForSelector('.token:not(.acted)');
  ok(true, 'pressione prolungata azzera le spunte (visto da B)');

  // 7. + PNG con Invio nel campo nome
  await A.click('#btn-add-monster');
  await A.waitForSelector('#dlg-monster[open]');
  await A.fill('#form-monster [name=name]', 'Goblin');
  await A.fill('#form-monster [name=count]', '3');
  await A.press('#form-monster [name=name]', 'Enter');
  await B.waitForFunction(() => document.querySelectorAll('.token').length === 4);
  const names = await B.$$eval('.token .label', (els) => els.map((e) => e.firstChild.textContent));
  ok(names.includes('Goblin 1') && names.includes('Goblin 3'), 'PNG: tre goblin numerati (' + names.join(', ') + ')');

  // 8. help e privacy (apertura esclusiva)
  await A.click('summary:has-text("Come funziona")');
  ok(await A.evaluate(() => [...document.querySelectorAll('.help details')][0].open), 'Come funziona si apre');
  await A.click('summary:has-text("Privacy e cookie")');
  const st = await A.evaluate(() => [...document.querySelectorAll('.help details')].map((d) => d.open));
  ok(st[1] && !st[0], 'Privacy si apre e chiude l\'altro help (' + st + ')');
  ok((await A.textContent('.help')).includes('non imposta cookie propri'), 'testo privacy presente');
  if (OUT) await A.screenshot({ path: OUT + '/desktop-help.png', fullPage: true });

  // 9. mobile
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const M = await ctxM.newPage(); watch(M, 'M');
  await M.goto(`${BASE}/${slug}`); await M.waitForSelector('#dlg-profile[open]'); await M.click('#form-profile button[data-close]');
  await M.waitForSelector('.token');
  if (OUT) await M.screenshot({ path: OUT + '/mobile.png' });
  const overflow = await M.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, 'mobile: nessuno scorrimento orizzontale della pagina');

  // 10. eliminazione della board con conferma
  await A.click('#btn-config'); await A.waitForSelector('#dlg-config[open]');
  ok(await A.isVisible('#btn-delete-board'), 'il menu Board mostra Elimina la board');
  await A.click('#btn-delete-board'); await A.waitForSelector('#dlg-delete[open]');
  ok(await A.isDisabled('#btn-confirm-delete'), 'Elimina è disattivato finché non scrivi il nome');
  await A.fill('#form-delete [name=confirm]', 'sbagliato');
  ok(await A.isDisabled('#btn-confirm-delete'), '...e resta disattivato con un nome sbagliato');
  await A.press('#form-delete [name=confirm]', 'Enter'); await A.waitForTimeout(300);
  ok(await B.evaluate(() => document.querySelectorAll('.token').length) === 4, 'Invio con nome sbagliato non elimina nulla');
  await A.fill('#form-delete [name=confirm]', slug.toUpperCase());
  ok(await A.isEnabled('#btn-confirm-delete'), 'con il nome giusto (anche maiuscolo) si attiva');
  await A.click('#btn-confirm-delete');
  await A.waitForSelector('#gone:not([hidden])'); await B.waitForSelector('#gone:not([hidden])');
  ok(true, 'A e B vedono "Board eliminata"');
  await A.waitForTimeout(1500);
  ok(await A.isVisible('#gone') && !(await A.isVisible('#board-view')), 'nessuna riconnessione automatica dopo l\'eliminazione');
  if (OUT) await A.screenshot({ path: OUT + '/eliminata.png' });

  ok(errs.length === 0, 'nessun errore JavaScript nella console' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await browser.close();
  app.close();
  console.log(fails ? `\n${fails} VERIFICHE FALLITE` : '\nTUTTE LE VERIFICHE PASSATE');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRORE DI ESECUZIONE:', e.message.split('\n')[0]); process.exit(2); });
