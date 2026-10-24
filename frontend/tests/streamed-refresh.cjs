/*
 * A successful operation must remain terminal when its projection response
 * starts with HTTP 200 but stalls in the JSON body. Build frontend first.
 * Only the isolated loopback server below receives requests; no application
 * services or existing data are used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const sockets = new Set();
const operation = { id: 'streamed-operation', status: 'received', attempts: 0 };
const terminal = { ...operation, status: 'succeeded', attempts: 1, outcome: 'applied' };
const initial = {
  id: 1,
  external_id: 'streamed-fixture',
  title: 'Before streamed refresh',
  status: 'NEW',
  amount: '1.00',
  external_version: 1,
  external_updated_at: null,
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
};
let dealReads = 0;
let operationReads = 0;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/operations/streamed-operation') {
    operationReads++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: terminal }));
    return;
  }
  if (pathname === '/api/deals/1') {
    dealReads++;
    response.setHeader('Content-Type', 'application/json');
    if (dealReads === 2) {
      // Send real headers and partial bytes. The response.json() promise must
      // reject on timeout instead of having that rejection swallowed.
      response.writeHead(200);
      response.write('{"data":');
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          ...initial,
          title: dealReads > 2 ? 'Recovered streamed refresh' : initial.title,
          latest_sync_operation: dealReads > 2 ? terminal : operation,
        },
      }),
    );
    return;
  }
  if (pathname.startsWith('/api/')) {
    response.writeHead(404).end();
    return;
  }
  const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(dist + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  const extension = path.extname(file);
  response.setHeader(
    'Content-Type',
    extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'text/html',
  );
  fs.createReadStream(file)
    .on('error', () => response.writeHead(404).end())
    .pipe(response);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

(async () => {
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#/deals/1`);
    await page.getByText('Успешно обновлено', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText(/Сервер не ответил вовремя/).waitFor();
    await page.getByText(/Данные на экране могут быть устаревшими/).waitFor();
    assert.equal(await page.locator('h1').textContent(), initial.title);
    assert.equal(
      await page.getByRole('button', { name: 'Обновить из внешней CRM', exact: true }).isEnabled(),
      true,
    );
    assert.equal(operationReads, 1, 'Known terminal status must not be polled indefinitely');
    assert.equal(dealReads, 2, 'A timed out projection must await explicit retry');
    await page.getByRole('button', { name: 'Повторить загрузку карточки', exact: true }).click();
    await page.getByRole('heading', { name: 'Recovered streamed refresh', exact: true }).waitFor();
    assert.equal(await page.getByText(/Данные на экране могут быть устаревшими/).count(), 0);
    assert.equal(dealReads, 3);
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        scenario: 'terminal-success-streamed-body-timeout-and-recovery',
        status: 'PASS',
        dealReads,
        operationReads,
        isolatedMock: true,
      }),
    );
  } finally {
    if (browser) await browser.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
