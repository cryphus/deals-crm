"""Interview fixtures and demonstrable webhook; Python standard library only.

seed preserves existing records, including manual changes to previous fixtures.
verify invokes the real HTTP/worker acceptance suite. No database is cleared.
"""
import argparse
import json
from pathlib import Path
import sys
import uuid

import smoke


ROOT = Path(__file__).resolve().parents[1]


def seed():
    fixtures = json.loads((ROOT / 'examples/deals.json').read_text(encoding='utf-8'))
    for fixture in fixtures:
        try:
            deal = smoke.find_deal(fixture['external_id'])
            action = 'preserved'
        except StopIteration:
            code, response = smoke.api('POST', '/api/deals', fixture)
            smoke.must(code == 201, f'create {fixture["external_id"]}: HTTP {code}')
            deal = response['data']
            action = 'created'
        print(f'{action}: {fixture["external_id"]} -> deal #{deal["id"]}')
    print('READY: 15 synthetic fixtures. Search for "Демо:" in the list to show them.')
    print('Existing deals and edits were preserved. No personal data is used.')


def webhook(args):
    body = json.loads((ROOT / 'examples/webhook.json').read_text(encoding='utf-8'))
    body['event_id'] = args.event_id or 'interview-' + uuid.uuid4().hex
    body['deal']['id'] = args.external_id
    body['deal']['version'] = args.version
    code, response = smoke.send_event(body)
    smoke.must(code == 202, f'webhook acceptance: HTTP {code}')
    operation_id = smoke.event_operation(response)
    operation, _ = smoke.wait_operation(operation_id)
    print(json.dumps({key: operation.get(key) for key in
        ('id', 'event_id', 'status', 'attempts', 'outcome', 'error')}, ensure_ascii=False, indent=2))
    smoke.must(operation['status'] == 'succeeded', 'Webhook processing did not succeed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('seed', help='Create 15 synthetic deals without overwriting existing records')
    commands.add_parser('verify', help='Run all five real HTTP/worker acceptance scenarios')
    event = commands.add_parser('webhook', help='Send and await a versioned webhook without printing its token')
    event.add_argument('--version', type=int, default=21)
    event.add_argument('--external-id', default='demo-01')
    event.add_argument('--event-id', help='Reuse this ID to demonstrate deduplication')
    args = parser.parse_args()
    if args.command == 'seed':
        seed()
    elif args.command == 'verify':
        smoke.main()
    elif args.version < 1:
        parser.error('version must be positive')
    else:
        webhook(args)


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
