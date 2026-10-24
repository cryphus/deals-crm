/*
 * Isolated UI workflows. Build frontend first, then run this file.
 * Every API request is fulfilled by synthetic fixtures. No application API,
 * database, Redis instance, or existing deal is touched.
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
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
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
  external_id: 'workflow-fixture-1',
  title: 'Продажа курса английского языка',
  status: 'NEW',
  amount: '100.00',
  external_version: 20,
  external_updated_at: null,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
};
const operation = { id: 'workflow-operation', status: 'received', attempts: 0 };

async function isolatedPage(browser, handler) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', handler);
  return { page, errors };
}

async function runCrudAndFilters(browser, origin) {
  const deals = Array.from({ length: 23 }, (_, index) => ({
    ...initial,
    id: index + 1,
    external_id: `workflow-fixture-${index + 1}`,
    title: `${initial.title} ${index + 1}`,
    status: index % 2 ? 'WON' : 'NEW',
  }));
  let lastList;
  let patchRejected = true;
  let createRejected = true;
  let listUnavailable = false;
  let createdCount = 0;
  const { page, errors } = await isolatedPage(browser, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/api/deals' && method === 'GET') {
      lastList = Object.fromEntries(url.searchParams);
      if (listUnavailable) return route.fulfill({ status: 503, json: { message: 'unavailable' } });
      const q = url.searchParams.get('q') || '';
      const status = url.searchParams.get('status') || '';
      const currentPage = Number(url.searchParams.get('page') || 1);
      const filtered = deals.filter(
        (deal) =>
          (!q || deal.title.includes(q) || deal.external_id.includes(q)) &&
          (!status || deal.status === status),
      );
      return route.fulfill({
        json: {
          data: filtered.slice((currentPage - 1) * 10, currentPage * 10),
          current_page: currentPage,
          last_page: Math.max(1, Math.ceil(filtered.length / 10)),
          per_page: 10,
          total: filtered.length,
        },
      });
    }
    if (url.pathname === '/api/deals' && method === 'POST') {
      if (createRejected)
        return route.fulfill({ status: 422, json: { message: 'External ID already exists.' } });
      createdCount++;
      const deal = { ...initial, ...request.postDataJSON(), id: 99 };
      deals.push(deal);
      return route.fulfill({ status: 201, json: { data: deal } });
    }
    const match = url.pathname.match(/^\/api\/deals\/(\d+)$/);
    if (match) {
      const index = deals.findIndex((deal) => deal.id === Number(match[1]));
      assert.ok(index >= 0, `Fixture deal ${match[1]} must exist`);
      if (method === 'PATCH') {
        if (patchRejected)
          return route.fulfill({ status: 422, json: { errors: { amount: ['invalid'] } } });
        deals[index] = { ...deals[index], ...request.postDataJSON() };
      } else assert.equal(method, 'GET');
      return route.fulfill({ json: { data: deals[index] } });
    }
    throw new Error(`Unexpected isolated request: ${method} ${url.pathname}`);
  });
  try {
    await page.goto(`${origin}/#/deals`);
    await page.getByText('1–10 / 23', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
    await page.getByText('11–20 / 23', { exact: true }).waitFor();
    assert.equal(lastList.page, '2');

    await page
      .getByRole('searchbox', { name: 'Поиск сделок', exact: true })
      .fill('workflow-fixture-23');
    await page.getByText('1–1 / 1', { exact: true }).waitFor();
    assert.equal(lastList.page, '1', 'A new search resets pagination');
    assert.equal(lastList.q, 'workflow-fixture-23');
    assert.equal(await page.locator('tbody .deal-link').count(), 1);
    await page.locator('.status-filter select').selectOption('WON');
    await page.getByText('Нет сделок по этим условиям', { exact: true }).waitFor();
    assert.equal(lastList.status, 'WON');
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page.getByText('1–10 / 23', { exact: true }).waitFor();
    assert.equal(lastList.q, '');
    assert.equal(lastList.status, '');
    await page.locator('.status-filter select').selectOption('WON');
    await page.getByText('1–10 / 11', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody .status-WON').count(), 10);
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page.getByText('1–10 / 23', { exact: true }).waitFor();

    await page.getByRole('button', { name: deals[0].title, exact: true }).click();
    await page.getByRole('heading', { name: deals[0].title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('Название сделки').fill('Сохранённая локальная правка');
    await page.getByLabel('Сумма', { exact: true }).fill('0');
    await page.getByLabel('Статус').selectOption('WON');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText(/Укажите сумму от 0/).waitFor();
    const amountInput = page.getByLabel('Сумма', { exact: true });
    assert.equal(await amountInput.getAttribute('aria-invalid'), 'true');
    assert.equal(await amountInput.getAttribute('aria-describedby'), 'amount-error');
    assert.equal(await amountInput.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.getByText('Проверьте отмеченные поля.', { exact: true }).count(), 1);
    assert.equal(
      await page.getByText(/Укажите сумму от 0/).count(),
      1,
      'Field text is not duplicated in the summary',
    );
    assert.equal(
      await page.getByLabel('Название сделки').inputValue(),
      'Сохранённая локальная правка',
    );
    assert.equal(await page.getByLabel('Сумма', { exact: true }).inputValue(), '0');
    patchRejected = false;
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Изменения сохранены.', { exact: true }).waitFor();
    assert.equal(deals[0].title, 'Сохранённая локальная правка');
    assert.equal(deals[0].amount, 0);
    assert.equal(deals[0].status, 'WON');
    await page.getByRole('heading', { name: deals[0].title, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('Название сделки').fill('Этот черновик отменён');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('heading', { name: deals[0].title, exact: true }).waitFor();
    assert.equal(deals[0].title, 'Сохранённая локальная правка');

    patchRejected = true;
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText(/Укажите сумму от 0/).waitFor();
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    assert.equal(
      await page.getByLabel('Сумма', { exact: true }).getAttribute('aria-invalid'),
      'false',
    );
    assert.equal(
      await page.locator('#amount-error').count(),
      0,
      'A new edit does not inherit the cancelled error',
    );
    assert.equal(await page.getByText('Проверьте отмеченные поля.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();

    await page.getByRole('button', { name: 'Сделки', exact: true }).click();
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByLabel('Название сделки').fill('Новая нулевая сделка');
    await page.getByLabel('Внешний ID', { exact: false }).fill('workflow-created');
    await page.getByRole('button', { name: 'Создать сделку', exact: true }).click();
    await page.getByText(/Сделка с таким внешним ID уже существует/).waitFor();
    const externalInput = page.getByLabel('Внешний ID', { exact: true });
    assert.equal(await externalInput.getAttribute('aria-invalid'), 'true');
    assert.equal(
      await externalInput.getAttribute('aria-describedby'),
      'external-id-help external-id-error',
    );
    assert.equal(
      await externalInput.evaluate((element) => element === document.activeElement),
      true,
    );
    assert.equal(await page.getByText(/Сделка с таким внешним ID уже существует/).count(), 1);
    assert.equal(await page.getByLabel('Название сделки').inputValue(), 'Новая нулевая сделка');
    createRejected = false;
    await page.getByRole('button', { name: 'Создать сделку', exact: true }).click();
    await page.getByRole('heading', { name: 'Новая нулевая сделка', exact: true }).waitFor();
    assert.equal(createdCount, 1);
    assert.equal(deals.at(-1).amount, 0);
    assert.match(page.url(), /#\/deals\/99$/);
    await page.reload();
    await page.getByRole('heading', { name: 'Новая нулевая сделка', exact: true }).waitFor();

    listUnavailable = true;
    await page.getByRole('button', { name: 'Сделки', exact: true }).click();
    await page.getByRole('button', { name: 'Загрузить снова', exact: true }).waitFor();
    listUnavailable = false;
    await page.getByRole('button', { name: 'Загрузить снова', exact: true }).click();
    await page.getByText('1–10 / 24', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    const result = {
      scenario: 'CRUD-search-status-pagination-errors-recovery',
      status: 'PASS',
      isolatedMock: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await page.close();
  }
}

async function runRepeatedRefreshRecovery(browser, origin) {
  let dealReads = 0;
  let refreshAvailable = false;
  const terminal = { ...operation, status: 'succeeded', attempts: 1, outcome: 'applied' };
  const { page, errors } = await isolatedPage(browser, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/operations/workflow-operation')
      return route.fulfill({ json: { data: terminal } });
    if (url.pathname === '/api/deals/1') {
      dealReads++;
      if (dealReads > 1 && !refreshAvailable)
        return route.fulfill({ status: 503, json: { message: 'unavailable' } });
      return route.fulfill({
        json: {
          data: {
            ...initial,
            title: refreshAvailable ? 'Карточка восстановлена' : initial.title,
            latest_sync_operation: refreshAvailable ? terminal : operation,
          },
        },
      });
    }
    throw new Error(`Unexpected isolated request: ${url.pathname}`);
  });
  try {
    await page.goto(`${origin}/#/deals/1`);
    await page.getByText('Успешно обновлено', { exact: true }).waitFor();
    await page.getByText(/Данные на экране могут быть устаревшими/).waitFor();
    assert.equal(await page.locator('h1').textContent(), initial.title);
    const retry = page.getByRole('button', { name: 'Повторить загрузку карточки', exact: true });
    const repeatedFailure = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/deals/1' && response.status() === 503,
    );
    await retry.click();
    await repeatedFailure;
    await page.getByText(/Данные на экране могут быть устаревшими/).waitFor();
    assert.equal(
      await page.getByRole('alert').count(),
      1,
      'One failed refresh has one explanatory alert',
    );
    assert.equal(await retry.isEnabled(), true, 'A second failed read must preserve retry');
    assert.equal(await page.getByText('Успешно обновлено', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('h1').textContent(), initial.title);
    refreshAvailable = true;
    await retry.click();
    await page.getByRole('heading', { name: 'Карточка восстановлена', exact: true }).waitFor();
    assert.equal(await page.getByText(/Данные на экране могут быть устаревшими/).count(), 0);
    assert.equal(await retry.count(), 0);
    assert.equal(dealReads, 4, 'Initial read, two failures, then recovery');
    assert.deepEqual(errors, []);
    const result = {
      scenario: 'two-failed-refreshes-then-recovery',
      status: 'PASS',
      dealReads,
      isolatedMock: true,
    };
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
    await runCrudAndFilters(browser, origin);
    await runRepeatedRefreshRecovery(browser, origin);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
