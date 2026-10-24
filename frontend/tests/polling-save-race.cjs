/*
 * Isolated regression for FE-001. Build frontend first, then run this file.
 * Playwright is pinned in the frontend devDependencies. Optional CHROME_PATH selects an installed
 * Chrome; otherwise Playwright uses its downloaded Chromium.
 * No request reaches the application API or its database.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../dist');
const server = http.createServer((req, res) => {
  const requestedPath = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = path.resolve(root, `.${requestedPath === '/' ? '/index.html' : requestedPath}`);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  const ext = path.extname(file);
  res.setHeader(
    'Content-Type',
    ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html',
  );
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.writeHead(404).end());
  stream.pipe(res);
});
const initial = {
  id: 1,
  external_id: 'race-fixture',
  title: 'External snapshot before edit',
  status: 'NEW',
  amount: '100.00',
  external_version: 20,
  external_updated_at: null,
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
};
const operation = { id: 'fixture-operation', status: 'received', attempts: 0 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function reached(gate, label) {
  let timeout;
  try {
    await Promise.race([
      gate.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function runScenario(browser, origin, scenario) {
  const page = await browser.newPage();
  let backendDeal = structuredClone(initial);
  let dealReads = 0;
  let operationReads = 0;
  const allowTerminal = deferred();
  const refreshReady = deferred();
  const patchReady = deferred();
  const releasePatch = deferred();
  const refreshedAgain = deferred();
  let heldRefresh;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/operations/fixture-operation') {
      operationReads++;
      await allowTerminal.promise;
      return route.fulfill({
        json: { data: { ...operation, status: 'succeeded', attempts: 1, outcome: 'applied' } },
      });
    }
    if (url.pathname === '/api/deals/1' && route.request().method() === 'PATCH') {
      patchReady.resolve();
      await releasePatch.promise;
      backendDeal = { ...backendDeal, ...route.request().postDataJSON() };
      return route.fulfill({ json: { data: backendDeal } });
    }
    if (url.pathname === '/api/deals/1') {
      dealReads++;
      if (dealReads === 1)
        return route.fulfill({
          json: { data: { ...backendDeal, latest_sync_operation: operation } },
        });
      if (dealReads === 2) {
        const capturedSnapshot = structuredClone(backendDeal);
        heldRefresh = () => route.fulfill({ json: { data: capturedSnapshot } });
        refreshReady.resolve();
        return;
      }
      refreshedAgain.resolve();
      return route.fulfill({ json: { data: backendDeal } });
    }
    throw new Error(`Unmatched isolated fixture: ${route.request().method()} ${url.pathname}`);
  });
  try {
    await page.goto(`${origin}/#/deals/1`);
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('Название сделки').fill('Confirmed local edit');
    if (scenario === 'GET-before-PATCH') {
      allowTerminal.resolve();
      await reached(refreshReady, 'pre-PATCH GET snapshot');
    }
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await reached(patchReady, 'PATCH request');
    if (scenario !== 'GET-before-PATCH') {
      allowTerminal.resolve();
      await reached(refreshReady, 'GET snapshot during PATCH');
    }
    if (scenario === 'GET-responds-during-PATCH') {
      await heldRefresh();
      // Keep PATCH pending until the stale response has been consumed and a
      // replacement poll starts, proving saveInFlight alone rejects the snapshot.
      await reached(refreshedAgain, 'replacement poll while PATCH is still pending');
    }
    releasePatch.resolve();
    await page.getByText('Изменения сохранены.', { exact: true }).waitFor();
    const beforeDelayedGET = await page.locator('h1').textContent();
    await page.evaluate(() => {
      window.__raceTitles = [];
      new MutationObserver(() =>
        window.__raceTitles.push(document.querySelector('h1')?.textContent),
      ).observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    if (scenario !== 'GET-responds-during-PATCH') await heldRefresh();
    await reached(refreshedAgain, 'fresh GET after rejected stale snapshot');
    await page.getByText('Успешно обновлено', { exact: true }).waitFor();
    const afterDelayedGET = await page.locator('h1').textContent();
    const syncEnabled = await page
      .getByRole('button', { name: 'Обновить из внешней CRM', exact: true })
      .isEnabled();
    assert.equal(beforeDelayedGET, 'Confirmed local edit');
    assert.equal(afterDelayedGET, backendDeal.title);
    assert.equal(afterDelayedGET, 'Confirmed local edit');
    assert.ok(
      !(await page.evaluate(() => window.__raceTitles)).includes(initial.title),
      'A stale title must never flash after confirmed save',
    );
    assert.equal(syncEnabled, true, 'Terminal operation must clear pending and re-enable sync');
    assert.equal(
      dealReads,
      scenario === 'GET-responds-during-PATCH' ? 4 : 3,
      'Discarded snapshots must lead to a bounded fresh read and terminal state',
    );
    const result = {
      scenario,
      status: 'PASS',
      beforeDelayedGET,
      afterDelayedGET,
      backendTitle: backendDeal.title,
      savedNoticeStillVisible: await page
        .getByText('Изменения сохранены.', { exact: true })
        .isVisible(),
      terminalStatus: 'succeeded',
      syncEnabled,
      dealReads,
      operationReads,
      isolatedMock: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    allowTerminal.resolve();
    releasePatch.resolve();
    await page.close();
  }
}

async function runTerminalRefreshFailure(browser, origin, status, hanging = false) {
  const page = await browser.newPage();
  let dealReads = 0;
  let refreshAvailable = false;
  const terminal = {
    ...operation,
    status,
    attempts: status === 'failed' ? 4 : 1,
    outcome: status === 'succeeded' ? 'applied' : null,
    error: status === 'failed' ? 'External API HTTP 500' : null,
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/operations/fixture-operation') {
      return route.fulfill({ json: { data: terminal } });
    }
    if (url.pathname === '/api/deals/1') {
      dealReads++;
      if (dealReads > 1 && !refreshAvailable) {
        if (hanging) return;
        return route.fulfill({ status: 503, json: { message: 'Read temporarily unavailable' } });
      }
      return route.fulfill({
        json: {
          data: {
            ...initial,
            title: refreshAvailable ? 'Refreshed after outage' : initial.title,
            latest_sync_operation: refreshAvailable ? terminal : operation,
          },
        },
      });
    }
    throw new Error(`Unexpected fixture: ${url.pathname}`);
  });
  try {
    await page.goto(`${origin}/#/deals/1`);
    await page
      .getByText(status === 'failed' ? 'Не удалось обновить сделку' : 'Успешно обновлено', {
        exact: true,
      })
      .waitFor();
    await page.getByText(`Попыток: ${terminal.attempts}`, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Обновить из внешней CRM', exact: true }).isEnabled(),
      true,
    );
    if (status === 'succeeded') {
      await page.getByText(/Данные на экране могут быть устаревшими/).waitFor();
      assert.equal(await page.locator('h1').textContent(), initial.title);
      refreshAvailable = true;
      await page.getByRole('button', { name: 'Повторить загрузку карточки', exact: true }).click();
      await page.getByRole('heading', { name: 'Refreshed after outage', exact: true }).waitFor();
      assert.equal(await page.getByText(/Данные на экране могут быть устаревшими/).count(), 0);
    } else {
      assert.equal(dealReads, 1, 'Failed operation must not depend on a second deal read');
    }
    const result = {
      scenario: `terminal-${status}-deal-read-${hanging ? 'timeout' : 'unavailable'}`,
      status: 'PASS',
      isolatedMock: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await page.close();
  }
}

async function runResponsiveList(browser, origin) {
  const page = await browser.newPage();
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: {
        data: [initial],
        current_page: 1,
        last_page: 1,
        per_page: 10,
        total: 1,
        from: 1,
        to: 1,
      },
    }),
  );
  try {
    const widths = [320, 390, 541, 600, 620, 621, 679, 680, 681, 768, 1024, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/#/deals`);
      await page.getByRole('button', { name: initial.title, exact: true }).waitFor();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        titleWidth: document.querySelector('.deal-link').getBoundingClientRect().width,
      }));
      assert.equal(layout.overflow, false, `No horizontal overflow at ${width}px`);
      assert.ok(
        layout.titleWidth >= 140,
        `Readable deal title at ${width}px, got ${layout.titleWidth}`,
      );
    }
    const result = { scenario: 'responsive-list', status: 'PASS', widths, isolatedMock: true };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await page.close();
  }
}

(async () => {
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const scenario of [
      'GET-before-PATCH',
      'GET-during-PATCH-responds-after',
      'GET-responds-during-PATCH',
    ]) {
      await runScenario(browser, origin, scenario);
    }
    for (const status of ['failed', 'succeeded']) {
      await runTerminalRefreshFailure(browser, origin, status);
    }
    await runTerminalRefreshFailure(browser, origin, 'succeeded', true);
    await runResponsiveList(browser, origin);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
