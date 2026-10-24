# Архитектура и API учебной CRM

## Webhook и воспроизводимый mock

Webhook: `POST /api/webhooks/deals`, `Content-Type: application/json`, секрет из локальной `.env` в заголовке `X-Webhook-Token`. Файл `.env` не отслеживается Git; не вставляйте реальный секрет в команды, историю терминала или отчёты.

Пример тела (секрет сюда не входит):

```json
{
  "event_id": "evt_demo_21",
  "event_time": "2026-10-15T15:30:00Z",
  "deal": {
    "id": "5678", "version": 21,
    "updated_at": "2026-10-15T15:29:50Z",
    "title": "Продажа курса", "status": "NEW", "amount": 49000
  }
}
```

Для отправки без вывода секрета используйте Python из корня проекта:

```python
import json, urllib.request
from pathlib import Path
env = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines() if '=' in line)
body = {"event_id":"evt_demo_21","event_time":"2026-10-15T15:30:00Z","deal":{"id":"5678","version":21,"updated_at":"2026-10-15T15:29:50Z","title":"Продажа курса","status":"NEW","amount":49000}}
req = urllib.request.Request('http://localhost:'+env.get('APP_PORT','8180')+'/api/webhooks/deals', data=json.dumps(body).encode(), headers={'Content-Type':'application/json','Accept':'application/json','X-Webhook-Token':env['WEBHOOK_TOKEN']})
print(urllib.request.urlopen(req).read().decode())
```

Ответ `202 {data: operation}` содержит ID операции. Повтор того же `event_id`, включая конкурентную доставку, возвращает одну сохранённую операцию. При одинаковом `event_id` и другом теле действует **первое принятое тело**. Для нового события нужен новый ID.

Прямые mock-запросы:

```text
GET http://localhost:8180/mock-api/deals/5678?mode=success&version=22
GET http://localhost:8180/mock-api/deals/5678?mode=rate_limit&operation_id=demo-a&version=22
GET http://localhost:8180/mock-api/deals/5678?mode=error
```

Второй URL вызовите три раза: 429, 429, 200. Для повторения с нуля задайте новый `operation_id`; состояние счётчика хранится в Redis с TTL 24 часа. `success` всегда 200, `error` всегда 500. Параметр `version` позволяет воспроизвести старый GET (по умолчанию 20). В фоновом обновлении режим и версию задаёт `POST /api/deals/{id}/sync {"mode":"success","version":22}`. Для каждой такой операции генерируется новый ID сценария.

## API

| Метод и путь | Результат |
| --- | --- |
| `GET /api/deals?q=&status=&page=1` | Laravel paginator: `data`, `current_page`, `last_page`, `total` |
| `POST /api/deals` | `{title,status,amount,external_id?}` → `201 {data:deal}` |
| `GET /api/deals/{id}` | `{data:deal}`, включая последнюю sync-операцию |
| `PATCH /api/deals/{id}` | Изменение `title`, `status`, `amount` |
| `POST /api/deals/{id}/sync` | `{mode?,version?}` → `202 {data:operation}` |
| `GET /api/operations/{uuid}` | Статус, попытки, последняя ошибка, outcome |
| `GET /api/events?page=1` | Журнал операций с пагинацией, 20 записей |
| `POST /api/webhooks/deals` | Валидированный webhook с секретом → `202` |
| `GET /mock-api/deals/{external_id}` | Внешние бизнес-поля сделки |

Статусы сделки: `NEW`, `IN_PROGRESS`, `WON`, `LOST`. Внешний ID — строка до 120 символов из букв, цифр, `_`, `-`. Версия — положительное JSON integer до `2^53-1`; сумма — JSON number ≥0, до двух знаков после запятой. В БД сумма хранится как `numeric(14,2)` и в API сделки сериализуется строкой для сохранения десятичной точности. Для ручной сделки без внешнего ID создаётся `manual-<uuid>`: учебный mock обслуживает любой такой ID. В настоящей интеграции понадобилось бы явное связывание.

## Архитектура и гарантии

```text
React → nginx → Laravel API → PostgreSQL operations (durable inbox)
                                ↓ dispatcher every 2 seconds
                           Redis → queue worker → mock HTTP
                                ↑                   ↓
                         inbox dispatcher       ExternalDeal
                         (recovery loop)       lock + version check
                                                   ↓
                                            PostgreSQL deals
```

Событие записывается в PostgreSQL до успешного ответа. Уникальный индекс `operations.event_id` и `INSERT ... ON CONFLICT DO NOTHING` защищают при одновременном приёме. HTTP-приём webhook и sync обращается только к SQL: недоступный Redis не задерживает ответ. Отдельный диспетчер каждые 2 секунды отправляет доступные операции в Redis и повторяет отправку при сбое. `queued_at` — короткая аренда публикации (15 секунд), а не доказательство доставки. Поэтому даже потеря уже опубликованной Redis-задачи восстанавливается из SQL.

Worker атомарно захватывает операцию с `FOR UPDATE`, увеличивает число попыток, сохраняет статус и аренду 60 секунд. UUID токена аренды защищает от позднего коммита старого worker после повторного захвата. Применение бизнес-изменения и успешный статус операции — одна SQL-транзакция. При падении worker диспетчер восстанавливает просроченную аренду; количество попыток учитывается и при таких падениях. Условия обработки повторно проверяются, поэтому повторная доставка задачи безопасна.

Все изменения одной сделки сериализуются `pg_advisory_xact_lock(hashtextextended(external_id,0))`, включая создание отсутствующей сделки, плюс блокировкой строки. HTTP GET выполняется до этой транзакции, а версия сравнивается **после ответа внутри блокировки**. Поэтому медленный старый GET не затирает уже применённый новый webhook. Доставка задач — at least once; бизнес-применение одного webhook — не более одного раза.

429, 500 и сетевые ошибки повторяются максимум 4 раза с задержками **2, 5, 10 секунд** плюс время опроса диспетчера (2 секунды), очереди и HTTP. Невалидный ответ / ошибка схемы не повторяется. Ошибки и статус хранятся в SQL; сырые исключения, входящие заголовки и секрет не пишутся в журнал приложения. `operations` — журнал принятых событий и текущих состояний, без отдельной истории каждого перехода; количество попыток сохраняется. `outcome`: `applied`, `ignored_stale`, `ignored_equal_version`, `ignored_equal_version_conflict`.

Контейнеры: API, отдельный worker, отдельный recovery dispatcher, отдельный mock HTTP-сервер (чтобы GET worker не зависел от однопоточного API), миграции, PostgreSQL, Redis и web. Это учебный запуск через `artisan serve`, не production HTTP-конфигурация.

## Источник истины и конфликт

Для **title, status, amount** внешняя CRM авторитетна при **строго большей** `deal.version`. Локальная правка не увеличивает внешнюю версию и **не отправляется** во внешнюю систему. До следующей большей внешней версии локальные значения сохраняются. Новая внешняя версия может заменить все три локальных поля — это сознательный выбор, который в UI следует учитывать менеджеру.

Одинаковая версия никогда не меняет поля; разные данные при одинаковой версии получают `ignored_equal_version_conflict`. Более старая версия получает `ignored_stale`. `event_time` — метаданные доставки, а `deal.updated_at` — время состояния источника; порядок определяется только `deal.version`. Время сервера и порядок завершения задач порядок версий не меняют. Например, GET v18, завершившийся после webhook v19, будет проигнорирован; локальная правка поверх v19 переживёт GET v19, но будет заменена v20.

## Индексы

`deals.external_id UNIQUE` — быстрый поиск связи и запрет двух сделок источника; первичный ключ `id` — карточка/сортировка. `(status,id)` — фильтр с сортировкой. `operations.event_id UNIQUE` — конкурентная дедупликация, `(status,available_at)` — доступные задания, `(status,lease_until)` — зависшие попытки, `(deal_id,kind,sequence)` — последняя операция сделки. Монотонный `sequence` задаёт стабильный порядок даже для операций, созданных в одну секунду. Поиск `ILIKE '%term%'` для маленького набора данных выполняет сканирование; для production добавили бы `pg_trgm`/GIN после измерения нагрузки.
