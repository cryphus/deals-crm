"""Real HTTP + PostgreSQL + Redis worker acceptance scenarios; no external packages.
Run from the repository after docker compose up: python scripts/smoke.py
Creates synthetic deals/events with unique IDs; does not remove existing data.
"""
import concurrent.futures
import datetime as dt
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
ENV = {}
for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        ENV[key] = value
BASE = os.environ.get('CRM_URL', 'http://127.0.0.1:' + ENV.get('APP_PORT', '8180'))
TOKEN = os.environ.get('WEBHOOK_TOKEN', ENV.get('WEBHOOK_TOKEN', ''))
RUN = uuid.uuid4().hex[:12]


def api(method, path, body=None, token=None):
    headers = {'Accept': 'application/json'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if token is not None:
        headers['X-Webhook-Token'] = token
    request = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def must(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_operation(op_id, timeout=90):
    deadline = time.monotonic() + timeout
    observed = set()
    while time.monotonic() < deadline:
        code, response = api('GET', '/api/operations/' + str(op_id))
        must(code == 200, f'operation read: {code}')
        operation = response['data']
        observed.add(operation['status'])
        if operation['status'] in ('succeeded', 'failed'):
            return operation, observed
        time.sleep(.5)
    raise AssertionError(f'operation {op_id} never terminated; states={observed}')


def payload(event_id, external_id, version, title=None):
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    return {'event_id': event_id, 'event_time': now, 'deal': {
        'id': external_id, 'version': version, 'updated_at': now,
        'title': title or f'External v{version}', 'status': 'NEW', 'amount': 49000}}


def send_event(body):
    return api('POST', '/api/webhooks/deals', body, TOKEN)


def find_deal(external_id):
    code, response = api('GET', '/api/deals?q=' + urllib.parse.quote(external_id))
    must(code == 200, 'list failed')
    return next(deal for deal in response['data'] if deal['external_id'] == external_id)


def event_operation(response):
    data = response['data']
    return data['id']


def main():
    external_id = f'smoke-{RUN}'
    body = payload(f'evt-{RUN}-concurrent', external_id, 30)
    code, _ = api('POST', '/api/webhooks/deals', body, 'invalid')
    must(code == 401, 'invalid webhook token must be rejected')
    code, _ = api('POST', '/api/webhooks/deals', {'event_id': 'invalid'}, TOKEN)
    must(code == 422, 'invalid webhook body must be rejected')
    print('PASS token and validation')

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(lambda _: send_event(body), range(8)))
    must(all(code in (200, 202) for code, _ in responses), 'concurrent intake failed')
    ids = {str(event_operation(response)) for _, response in responses}
    must(len(ids) == 1, 'duplicate event IDs created different operations')
    operation, _ = wait_operation(ids.pop())
    must(operation['status'] == 'succeeded', 'webhook did not apply')
    deal = find_deal(external_id)
    must(int(deal['external_version']) == 30, 'wrong version')
    print('PASS scenario 1: concurrent duplicate event_id -> one durable operation')

    code, response = send_event(payload(f'evt-{RUN}-old', external_id, 10))
    must(code == 202, 'old event intake failed')
    wait_operation(event_operation(response))
    deal = find_deal(external_id)
    must(int(deal['external_version']) == 30, 'old webhook overwrote new data')
    code, response = api('POST', f"/api/deals/{deal['id']}/sync", {'mode': 'success', 'version': 20})
    must(code == 202, 'sync not accepted')
    operation, _ = wait_operation(response['data']['id'])
    must(operation['status'] == 'succeeded', 'stale GET handling failed')
    must(int(find_deal(external_id)['external_version']) == 30, 'old GET overwrote webhook')
    print('PASS scenario 2: older webhook and real GET cannot overwrite v30')

    for mode, expected, attempts in [('rate_limit', 'succeeded', 3), ('error', 'failed', 4)]:
        code, response = api('POST', f"/api/deals/{deal['id']}/sync", {'mode': mode, 'version': 31})
        must(code == 202 and response['data']['status'] == 'received', 'expected durable accepted state')
        started = time.monotonic()
        operation, states = wait_operation(response['data']['id'])
        elapsed = time.monotonic() - started
        must(operation['status'] == expected, f'{mode}: {operation}')
        must(int(operation['attempts']) == attempts, f'{mode}: expected {attempts} attempts')
        print(f'PASS scenario {3 if mode == "rate_limit" else 4}: {mode} -> {expected}; attempts={attempts}, {elapsed:.1f}s')

    deal = find_deal(external_id)
    code, _ = api('PATCH', f"/api/deals/{deal['id']}", {'title': 'Local correction', 'status': 'WON', 'amount': 0})
    must(code == 200, 'local edit failed')
    version = int(deal['external_version'])
    code, response = send_event(payload(f'evt-{RUN}-equal', external_id, version, 'Conflict equal'))
    wait_operation(event_operation(response))
    must(find_deal(external_id)['title'] == 'Local correction', 'same version overwrote local edit')
    code, response = send_event(payload(f'evt-{RUN}-new', external_id, version + 1, 'Strictly newer'))
    wait_operation(event_operation(response))
    must(find_deal(external_id)['title'] == 'Strictly newer', 'new external version not authoritative')
    print('PASS scenario 5: local edit survives equal version, newer external wins')
    code, response = api('GET', '/api/deals?status=NEW&page=1')
    must(code == 200 and 'last_page' in response and 'total' in response, 'pagination contract')
    must(all(row['status'] == 'NEW' for row in response['data']), 'status filter failed')
    print(f'ALL ACCEPTANCE SCENARIOS PASSED; synthetic run={RUN}')


if __name__ == '__main__':
    main()
