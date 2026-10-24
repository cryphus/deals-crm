import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Deal, DealInput, DealStatus, Operation, Page, SyncMode } from './api';
import {
  ApiValidationError,
  api,
  errorMessage,
  isAborted,
  operationErrorMessage,
  statusLabels,
} from './api';
import './styles.css';

type Route = number | 'new' | null;
const loadingRowKeys = ['loading-1', 'loading-2', 'loading-3', 'loading-4', 'loading-5'];
const formatAmount = (value: string | number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value));
const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const pending = (operation: Operation | null) =>
  operation?.status === 'received' || operation?.status === 'processing';
function readRoute(): Route {
  const match = location.hash.match(/^#\/deals\/(new|\d+)$/);
  if (!match) return null;
  return match[1] === 'new' ? 'new' : Number(match[1]) || null;
}

function Icon({ name }: { name: 'plus' | 'left' | 'right' }) {
  const paths = { plus: 'M12 5v14M5 12h14', left: 'm14 6-6 6 6 6', right: 'm10 6 6 6-6 6' };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function Status({ status }: { status: DealStatus }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

function DealForm({
  deal,
  saving,
  onSave,
  errors,
}: {
  deal?: Deal;
  saving: boolean;
  onSave: (data: DealInput) => void;
  errors: Record<string, string>;
}) {
  const [title, setTitle] = useState(deal?.title ?? '');
  const [status, setStatus] = useState<DealStatus>(deal?.status ?? 'NEW');
  const [amount, setAmount] = useState(String(deal?.amount ?? '0'));
  const [externalId, setExternalId] = useState('');
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  return (
    <form
      id="deal-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) {
          titleInput.current?.setCustomValidity('Введите название сделки.');
          titleInput.current?.reportValidity();
          return;
        }
        onSave({
          title: title.trim(),
          status,
          amount: Number(amount),
          ...(!deal && externalId.trim() ? { external_id: externalId.trim() } : {}),
        });
      }}
    >
      <fieldset disabled={saving}>
        <label className="title-field">
          Название сделки
          <textarea
            ref={titleInput}
            aria-label="Название сделки"
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'title-error' : undefined}
            // biome-ignore lint/a11y/noAutofocus: Opening this editor is an explicit user action; focus starts at its first field.
            autoFocus
            required
            rows={2}
            maxLength={255}
            value={title}
            onChange={(event) => {
              event.target.setCustomValidity('');
              setTitle(event.target.value);
            }}
            placeholder="Например, курс английского"
          />
          {errors.title && (
            <span id="title-error" className="field-error">
              {errors.title}
            </span>
          )}
        </label>
        <div className="form-grid">
          <label>
            Статус
            <select
              aria-label="Статус"
              aria-invalid={!!errors.status}
              aria-describedby={errors.status ? 'status-error' : undefined}
              value={status}
              onChange={(event) => setStatus(event.target.value as DealStatus)}
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {errors.status && (
              <span id="status-error" className="field-error">
                {errors.status}
              </span>
            )}
          </label>
          <label>
            Сумма
            <input
              aria-label="Сумма"
              aria-invalid={!!errors.amount}
              aria-describedby={errors.amount ? 'amount-error' : undefined}
              type="number"
              inputMode="decimal"
              required
              min="0"
              max="999999999999.99"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {errors.amount && (
              <span id="amount-error" className="field-error">
                {errors.amount}
              </span>
            )}
          </label>
          {!deal && (
            <label>
              Внешний ID <span className="optional">Необязательно</span>
              <input
                aria-label="Внешний ID"
                aria-invalid={!!errors.external_id}
                maxLength={120}
                pattern="[a-zA-Z0-9_\-]+"
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
                placeholder="Например, 5678"
                aria-describedby={`external-id-help${errors.external_id ? ' external-id-error' : ''}`}
              />
              {errors.external_id && (
                <span id="external-id-error" className="field-error">
                  {errors.external_id}
                </span>
              )}
              <span className="field-help" id="external-id-help">
                Латинские буквы, цифры, дефис и подчёркивание. Пустой ID создастся автоматически.
              </span>
            </label>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function OperationNotice({ operation }: { operation: Operation | null }) {
  if (!operation) return null;
  const labels: Record<Operation['status'], string> = {
    received: operation.attempts > 0 ? 'Ожидает повторной попытки' : 'Запрос принят',
    processing: 'Обновление выполняется',
    succeeded: operation.outcome === 'applied' ? 'Успешно обновлено' : 'Обновление завершено',
    failed: 'Не удалось обновить сделку',
  };
  const outcomes: Record<string, string> = {
    applied: 'Получена новая версия. Данные сделки обновлены.',
    ignored_stale: 'Получена более старая версия. Текущие данные сохранены.',
    ignored_equal_version: 'Данные уже актуальны. Изменений нет.',
    ignored_equal_version_conflict:
      'Получена та же версия с другими данными. Текущие значения сохранены.',
  };
  return (
    <div
      className={`notice operation ${operation.status === 'failed' ? 'error' : operation.status === 'succeeded' ? 'success' : ''}`}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>{labels[operation.status]}</strong>
        {operation.outcome && <p>{outcomes[operation.outcome] ?? 'Обработка завершена.'}</p>}
        {operation.error && <p>{operationErrorMessage(operation.error, pending(operation))}</p>}
        <p className="attempts">Попыток: {operation.attempts}</p>
      </div>
      <details className="technical-details">
        <summary>Подробности операции</summary>
        <dl>
          <div>
            <dt>ID операции</dt>
            <dd>{operation.id}</dd>
          </div>
          {operation.error && (
            <div>
              <dt>Ответ системы</dt>
              <dd>{operation.error}</dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}

function DealPage({
  id,
  onChanged,
  onClose,
}: {
  id: number | 'new';
  onChanged: (id?: number) => void;
  onClose: () => void;
}) {
  const [deal, setDeal] = useState<Deal | null>(null);
  const [editing, setEditing] = useState(id === 'new');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(id !== 'new');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<SyncMode>('success');
  const [operation, setOperation] = useState<Operation | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const dealRevision = useRef(0);
  const saveInFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    window.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!loading && !editing) heading.current?.focus({ preventScroll: true });
  }, [loading, editing]);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    if (id === 'new') return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ data: Deal }>(`/api/deals/${id}`, { signal: controller.signal })
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setDeal(data);
          setOperation(data.latest_sync_operation ?? null);
          setPollError('');
        }
      })
      .catch((err) => {
        if (!isAborted(err)) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, reload]);

  const operationId = operation?.id;
  const isPending = pending(operation);
  useEffect(() => {
    if (!operationId || !isPending || id === 'new') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ data: Operation }>(`/api/operations/${operationId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setPollError('');
        if (!pending(result.data)) {
          if (result.data.status === 'failed') {
            setOperation(result.data);
            onChanged();
            return;
          }
          const snapshotRevision = dealRevision.current;
          let fresh: { data: Deal };
          try {
            fresh = await api<{ data: Deal }>(`/api/deals/${id}`, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
            });
          } catch (err) {
            if (isAborted(err)) return;
            // Operation status is authoritative even if reading its projection
            // fails. Keep the visible fields and allow an explicit refresh.
            setOperation(result.data);
            setPollError(
              `Операция завершена, но карточку загрузить не удалось. Данные на экране могут быть устаревшими. ${errorMessage(err)}`,
            );
            onChanged();
            return;
          }
          if (controller.signal.aborted) return;
          // A GET begun around a PATCH can contain an older snapshot. Read again
          // after that save settles before publishing the terminal operation.
          if (saveInFlight.current || snapshotRevision !== dealRevision.current) {
            timer = setTimeout(poll, 1500);
            return;
          }
          setDeal(fresh.data);
          setOperation(result.data);
          onChanged();
          return;
        }
        setOperation(result.data);
      } catch (err) {
        if (isAborted(err)) return;
        setPollError(
          `Не удалось проверить статус. Проверка повторится автоматически. ${errorMessage(err)}`,
        );
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 700);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [operationId, isPending, id, onChanged]);

  async function save(data: DealInput) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    saveInFlight.current = true;
    dealRevision.current += 1;
    setSaving(true);
    setFieldErrors({});
    setError('');
    setSaved(false);
    try {
      const result = await api<{ data: Deal }>(id === 'new' ? '/api/deals' : `/api/deals/${id}`, {
        method: id === 'new' ? 'POST' : 'PATCH',
        body: JSON.stringify(data),
        signal,
      });
      if (signal.aborted) return;
      setDeal(result.data);
      setEditing(false);
      setSaved(true);
      onChanged(result.data.id);
    } catch (err) {
      if (!isAborted(err)) {
        setFieldErrors(err instanceof ApiValidationError ? err.fields : {});
        setError(
          err instanceof ApiValidationError ? 'Проверьте отмеченные поля.' : errorMessage(err),
        );
      }
    } finally {
      saveInFlight.current = false;
      dealRevision.current += 1;
      if (!signal.aborted) setSaving(false);
    }
  }
  async function sync() {
    if (!deal) return;
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setStarting(true);
    setError('');
    setPollError('');
    setSaved(false);
    try {
      const result = await api<{ data: Operation }>(`/api/deals/${deal.id}/sync`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
        signal,
      });
      if (!signal.aborted) setOperation(result.data);
    } catch (err) {
      if (!isAborted(err)) setError(errorMessage(err));
    } finally {
      if (!signal.aborted) setStarting(false);
    }
  }

  const recordName =
    id === 'new'
      ? 'Новая сделка'
      : (deal?.title ?? (loading ? 'Загрузка сделки…' : `Сделка #${id}`));
  return (
    <main className="record-page">
      <div className="record-control">
        <nav className="breadcrumbs" aria-label="Путь к сделке">
          <button type="button" className="text-button" onClick={onClose}>
            <Icon name="left" />
            Сделки
          </button>
          <span aria-hidden="true">/</span>
          <span className="breadcrumb-name" title={recordName}>
            {recordName}
          </span>
        </nav>
        <div className="record-actions" key={editing ? 'edit-actions' : 'view-actions'}>
          {editing ? (
            <>
              <button
                key="save"
                className="primary"
                type="submit"
                form="deal-form"
                disabled={saving}
              >
                {saving ? 'Сохранение…' : id === 'new' ? 'Создать сделку' : 'Сохранить'}
              </button>
              <button
                key="cancel"
                type="button"
                disabled={saving}
                onClick={() => {
                  if (id === 'new') onClose();
                  else {
                    setError('');
                    setFieldErrors({});
                    setEditing(false);
                  }
                }}
              >
                Отмена
              </button>
            </>
          ) : (
            deal && (
              <>
                <button
                  key="edit"
                  type="button"
                  ref={editButton}
                  className="primary"
                  onClick={(event) => {
                    event.preventDefault();
                    setError('');
                    setFieldErrors({});
                    setSaved(false);
                    setEditing(true);
                  }}
                >
                  Редактировать
                </button>
                <button
                  key="sync"
                  type="button"
                  disabled={!deal.external_id || starting || isPending}
                  onClick={sync}
                >
                  {starting
                    ? 'Отправляем запрос…'
                    : isPending
                      ? 'Обновление выполняется…'
                      : 'Обновить из внешней CRM'}
                </button>
              </>
            )
          )}
        </div>
      </div>
      <article className="record-sheet" aria-labelledby="record-heading">
        <h1 id="record-heading" ref={heading} tabIndex={-1}>
          {editing ? (id === 'new' ? 'Новая сделка' : 'Редактирование сделки') : recordName}
        </h1>
        {error && (editing || !pollError) && (
          <div className="notice error" role="alert">
            <p>{error}</p>
            {!deal && id !== 'new' && (
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                Загрузить снова
              </button>
            )}
          </div>
        )}
        {loading ? (
          <div className="record-loading" role="status">
            <span className="sr-only">Загрузка карточки…</span>
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : editing ? (
          <DealForm deal={deal ?? undefined} saving={saving} onSave={save} errors={fieldErrors} />
        ) : (
          deal && (
            <>
              <dl className="record-fields">
                <div>
                  <dt>Статус</dt>
                  <dd>
                    <Status status={deal.status} />
                  </dd>
                </div>
                <div>
                  <dt>Сумма</dt>
                  <dd className="number">{formatAmount(deal.amount)}</dd>
                </div>
                <div>
                  <dt>Внешний ID</dt>
                  <dd>{deal.external_id ?? 'Не привязана'}</dd>
                </div>
                <div>
                  <dt>Обновлена</dt>
                  <dd>{formatDate(deal.updated_at)}</dd>
                </div>
                <div>
                  <dt>Внешняя версия</dt>
                  <dd>{deal.external_version ?? '—'}</dd>
                </div>
                <div>
                  <dt>Создана</dt>
                  <dd>{formatDate(deal.created_at)}</dd>
                </div>
              </dl>
              {saved && (
                <p className="save-result" role="status">
                  Изменения сохранены.
                </p>
              )}
              <section className="sync-section" aria-labelledby="sync-heading">
                <h2 id="sync-heading">Внешнее обновление</h2>
                {!operation && (
                  <p className="muted">
                    {deal.external_id
                      ? 'Обновление для этой сделки ещё не запускалось.'
                      : 'Для обновления нужен внешний ID.'}
                  </p>
                )}
                <OperationNotice operation={operation} />
                {pollError && (
                  <div className="notice error" role="alert">
                    <p>{pollError}</p>
                    {!isPending && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          setReload((value) => value + 1);
                        }}
                      >
                        Повторить загрузку карточки
                      </button>
                    )}
                  </div>
                )}
                <details className="test-scenarios">
                  <summary>Сценарии проверки</summary>
                  <label>
                    Ответ внешнего сервиса
                    <select
                      value={mode}
                      disabled={starting || isPending}
                      onChange={(event) => setMode(event.target.value as SyncMode)}
                    >
                      <option value="success">Успешное обновление (200)</option>
                      <option value="rate_limit">Две ошибки 429, затем успех</option>
                      <option value="error">Постоянная ошибка (500)</option>
                    </select>
                  </label>
                  <p className="field-help">
                    Выбранный сценарий применится при следующем обновлении.
                  </p>
                </details>
                {mode !== 'success' && (
                  <p className="scenario-active">
                    Выбран сценарий:{' '}
                    {mode === 'rate_limit'
                      ? 'две ошибки 429, затем успех'
                      : 'постоянная ошибка 500'}
                    .
                  </p>
                )}
              </section>
              <details className="source-details">
                <summary>Данные и правила синхронизации</summary>
                <dl>
                  <div>
                    <dt>Обновлена в источнике</dt>
                    <dd>{formatDate(deal.external_updated_at)}</dd>
                  </div>
                </dl>
                <p className="field-help">
                  Новая внешняя версия заменяет название, статус и сумму. Старая или одинаковая
                  версия сохраняет текущие данные. Локальные правки во внешнюю CRM не отправляются.
                </p>
              </details>
            </>
          )
        )}
      </article>
    </main>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<Deal> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<Route>(readRoute);
  const [revision, setRevision] = useState(0);
  const newButton = useRef<HTMLButtonElement>(null);
  const origin = useRef<{ id: number | 'new'; scroll: number } | null>(null);
  const routeRef = useRef(selectedId);
  const restoreRequested = useRef(false);
  const listRequest = useRef(0);
  const restoreRequest = useRef<number | null>(null);
  const [completedRequest, setCompletedRequest] = useState(0);

  useEffect(() => {
    function onHashChange() {
      const route = readRoute();
      if (routeRef.current !== null && route === null) {
        restoreRequested.current = true;
        restoreRequest.current = null;
      }
      routeRef.current = route;
      setSelectedId(route);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (selectedId !== null) return;
    const controller = new AbortController();
    const generation = ++listRequest.current;
    if (restoreRequested.current) restoreRequest.current = generation;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ q: debouncedQuery, status, page: String(page) });
    api<Page<Deal>>(`/api/deals?${params}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (page > data.last_page) {
          setPage(Math.max(1, data.last_page));
          return;
        }
        setResult(data);
        setCompletedRequest(generation);
      })
      .catch((err) => {
        if (!isAborted(err)) {
          setError(errorMessage(err));
          setCompletedRequest(generation);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQuery, status, page, revision, selectedId]);
  useEffect(() => {
    // Returning from a record must wait for this visit's refreshed list, not retained rows.
    if (
      selectedId !== null ||
      loading ||
      !restoreRequested.current ||
      restoreRequest.current !== completedRequest
    )
      return;
    const frame = requestAnimationFrame(() => {
      const previous = origin.current;
      const row =
        previous?.id !== 'new'
          ? document.querySelector<HTMLButtonElement>(`[data-deal-id="${previous?.id}"]`)
          : null;
      (row ?? newButton.current)?.focus({ preventScroll: true });
      window.scrollTo(0, row ? (previous?.scroll ?? 0) : 0);
      restoreRequested.current = false;
      restoreRequest.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, completedRequest, loading]);

  const onChanged = useCallback((id?: number) => {
    setRevision((value) => value + 1);
    if (id) {
      history.replaceState(null, '', `#/deals/${id}`);
      routeRef.current = id;
      setSelectedId(id);
    }
  }, []);
  function openRecord(id: number | 'new') {
    origin.current = { id, scroll: window.scrollY };
    location.hash = `/deals/${id}`;
  }
  function closeRecord() {
    if (origin.current) history.back();
    else {
      history.replaceState(null, '', '#/deals');
      routeRef.current = null;
      setSelectedId(null);
      restoreRequested.current = true;
      restoreRequest.current = null;
    }
  }
  function clearFilters() {
    setQuery('');
    setDebouncedQuery('');
    setStatus('');
    setPage(1);
  }
  const filtered = Boolean(query || status);
  const pageSize = result?.per_page ?? 0;
  const first = result?.total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, result?.total ?? 0);

  return (
    <>
      <header className="app-bar">
        <span className="app-name">CRM</span>
        <span className="app-divider" aria-hidden="true" />
        <span>Сделки</span>
      </header>
      {selectedId !== null ? (
        <DealPage key={selectedId} id={selectedId} onChanged={onChanged} onClose={closeRecord} />
      ) : (
        <main className="registry-page">
          <h1 className="sr-only">Сделки</h1>
          <section aria-label="Список сделок" className="registry">
            <div className="list-control">
              <button
                type="button"
                ref={newButton}
                className="primary create-button"
                onClick={() => openRecord('new')}
              >
                <Icon name="plus" />
                Создать
              </button>
              <div className="filter-controls">
                <label className="search">
                  <span className="sr-only">Поиск сделок</span>
                  <input
                    type="search"
                    maxLength={255}
                    placeholder="Поиск по названию или внешнему ID"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <label className="status-filter">
                  <span className="sr-only">Статус</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">Все статусы</option>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {filtered && (
                  <button
                    type="button"
                    className="text-button clear-filters"
                    onClick={clearFilters}
                  >
                    Сбросить
                  </button>
                )}
              </div>
              <nav className="pagination" aria-label="Страницы сделок">
                <span className="page-range" aria-live="polite">
                  {first}–{last} / {result?.total ?? 0}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Предыдущая страница"
                  disabled={loading || !!error || page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <Icon name="left" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Следующая страница"
                  disabled={loading || !!error || !result || page >= result.last_page}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <Icon name="right" />
                </button>
                <span className="sr-only">
                  Страница {page} из {result?.last_page ?? 1}
                </span>
              </nav>
            </div>
            {error && (
              <div className="notice error list-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => setRevision((value) => value + 1)}>
                  Загрузить снова
                </button>
              </div>
            )}
            <div className="table-wrapper" aria-busy={loading}>
              {/* biome-ignore lint/a11y/noRedundantRoles: Preserve explicit table semantics when mobile CSS changes display. */}
              <table role="table">
                <caption className="sr-only">
                  Сделки: название, внешний ID, статус, сумма и дата обновления
                </caption>
                <colgroup>
                  <col className="title-col" />
                  <col className="external-col" />
                  <col className="status-col" />
                  <col className="amount-col" />
                  <col className="date-col" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Название</th>
                    <th scope="col" className="external-cell">
                      Внешний ID
                    </th>
                    <th scope="col">Статус</th>
                    <th scope="col" className="right">
                      Сумма
                    </th>
                    <th scope="col" className="date-cell">
                      Обновлена
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {!result && loading
                    ? loadingRowKeys.map((key) => (
                        // biome-ignore lint/a11y/noAriaHiddenOnFocusable: Skeleton rows contain only non-focusable placeholders.
                        <tr key={key} className="loading-row" aria-hidden="true">
                          <td className="record-title">
                            <span className="skeleton" />
                          </td>
                          <td className="external-cell">
                            <span className="skeleton" />
                          </td>
                          <td className="record-status">
                            <span className="skeleton" />
                          </td>
                          <td className="record-amount">
                            <span className="skeleton" />
                          </td>
                          <td className="date-cell">
                            <span className="skeleton" />
                          </td>
                        </tr>
                      ))
                    : !error &&
                      result?.data.map((deal) => (
                        <tr key={deal.id}>
                          <td className="record-title">
                            <button
                              type="button"
                              className="deal-link"
                              data-deal-id={deal.id}
                              title={deal.title}
                              onClick={() => openRecord(deal.id)}
                            >
                              {deal.title}
                            </button>
                            <span
                              className="compact-external"
                              title={deal.external_id ?? undefined}
                            >
                              ID: {deal.external_id ?? '—'}
                            </span>
                          </td>
                          <td
                            className="external-cell external-id"
                            title={deal.external_id ?? undefined}
                          >
                            {deal.external_id ?? '—'}
                          </td>
                          <td
                            className="record-status"
                            aria-label={`Статус: ${statusLabels[deal.status]}`}
                          >
                            <Status status={deal.status} />
                          </td>
                          <td
                            className="record-amount right number"
                            aria-label={`Сумма: ${formatAmount(deal.amount)}`}
                          >
                            {formatAmount(deal.amount)}
                          </td>
                          <td className="date-cell date">
                            <span className="mobile-date-label">Обновлена </span>
                            {formatDate(deal.updated_at)}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
              {loading && (
                <span className="sr-only" role="status">
                  Загрузка сделок…
                </span>
              )}
              {!loading && !error && !result?.data.length && (
                <div className="empty">
                  <strong>{filtered ? 'Нет сделок по этим условиям' : 'Пока нет сделок'}</strong>
                  <p>
                    {filtered
                      ? 'Измените поиск или статус.'
                      : 'Создайте первую сделку, чтобы начать работу.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => (filtered ? clearFilters() : openRecord('new'))}
                  >
                    {filtered ? 'Сбросить фильтры' : 'Создать сделку'}
                  </button>
                </div>
              )}
            </div>
          </section>
        </main>
      )}
    </>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing.');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
