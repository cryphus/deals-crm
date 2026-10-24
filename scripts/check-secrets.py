"""Check tracked files for local generated secrets without printing their values."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
secrets = []
for line in (root / '.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        if key in {'APP_KEY', 'DB_PASSWORD', 'WEBHOOK_TOKEN'} and value:
            secrets.append(value.encode())
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\0')
leaks = []
for name in files:
    if not name:
        continue
    path = root / name.decode()
    if path.is_file() and any(secret in path.read_bytes() for secret in secrets):
        leaks.append(str(path.relative_to(root)))
if leaks:
    raise SystemExit('Secrets found in tracked files: ' + ', '.join(leaks))
print('PASS: generated local secrets are absent from tracked files.')
