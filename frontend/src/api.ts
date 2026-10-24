export type DealStatus = 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST';
export type SyncMode = 'success' | 'rate_limit' | 'error';
export interface Operation {
  id: string;
  status: 'received' | 'processing' | 'succeeded' | 'failed';
  attempts: number;
  error?: string | null;
  outcome?: string | null;
}
export interface Deal {
  id: number;
  external_id: string | null;
  title: string;
  status: DealStatus;
  amount: string | number;
  external_version: number | null;
  external_updated_at: string | null;
  created_at: string;
  updated_at: string;
  latest_sync_operation?: Operation | null;
}
export interface DealInput {
  title: string;
  status: DealStatus;
  amount: number;
  external_id?: string;
}
export interface Page<T> {
  data: T[];
  current_page: number;
  last_page: number;
  total: number;
  per_page: number;
}
export const statusLabels: Record<DealStatus, string> = {
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  WON: 'Выиграна',
  LOST: 'Проиграна',
};

export class ApiValidationError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string>,
  ) {
    super(message);
  }
}

export function operationErrorMessage(message: string, retrying = false): string {
  const recovery = retrying
    ? ' Следующая попытка начнётся автоматически.'
    : ' Попробуйте обновить сделку снова.';
  if (message === 'External API HTTP 429')
    return `Внешний сервис временно ограничил запросы.${recovery}`;
  if (/^External API HTTP 5\d\d$/.test(message)) return `Внешний сервис недоступен.${recovery}`;
  if (message === 'Temporary processing or connection failure.')
    return `Не удалось связаться с внешним сервисом или обработать ответ.${recovery}`;
  if (message === 'External API returned an invalid deal identity.')
    return 'Внешний сервис вернул другую сделку. Проверьте внешний ID и повторите обновление.';
  if (message === 'External payload failed schema validation.')
    return 'Внешний сервис вернул некорректные данные. Проверьте источник и повторите обновление.';
  if (message === 'Worker interrupted; attempt limit reached.')
    return 'Обработка прервалась, попытки исчерпаны. Запустите обновление снова.';
  return `Обновление не выполнено.${recovery}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch((error: unknown) => {
    // A timeout can also interrupt a streamed body after headers arrived.
    if (
      error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    )
      throw error;
    if (response.ok) throw new Error('Сервер вернул некорректный ответ. Повторите загрузку.');
    return null;
  });
  if (response.ok && body === null)
    throw new Error('Сервер вернул пустой ответ. Повторите загрузку.');
  if (!response.ok) {
    if (body?.message === 'External ID already exists.') {
      const message =
        'Сделка с таким внешним ID уже существует. Укажите другой ID или найдите существующую сделку через поиск.';
      throw new ApiValidationError(message, { external_id: message });
    }
    if (body?.errors) {
      const fieldMessages: Record<string, string> = {
        title: 'Введите название сделки длиной до 255 символов.',
        status: 'Выберите статус сделки из списка.',
        amount: 'Укажите сумму от 0 до 999 999 999 999,99, не более двух знаков после запятой.',
        external_id:
          'Проверьте внешний ID: до 120 символов, латинские буквы, цифры, дефис и подчёркивание.',
        q: 'Сократите поисковый запрос до 255 символов.',
      };
      const fields = Object.fromEntries(
        Object.keys(body.errors).map((field) => [
          field,
          fieldMessages[field] ?? 'Проверьте введённые данные и повторите действие.',
        ]),
      );
      throw new ApiValidationError(Object.values(fields).join(' '), fields);
    }
    if (response.status === 404)
      throw new Error('Сделка или операция не найдена. Закройте карточку и обновите список.');
    if (response.status === 429)
      throw new Error('Слишком много запросов. Подождите немного и повторите действие.');
    if (response.status >= 500)
      throw new Error('Сервер временно недоступен. Повторите действие через несколько секунд.');
    throw new Error('Не удалось выполнить действие. Проверьте данные и повторите запрос.');
  }
  return body as T;
}

export function isAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'Сервер не ответил вовремя. Повторите загрузку.';
  if (error instanceof TypeError)
    return 'Нет связи с сервером. Проверьте подключение и повторите действие.';
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить запрос. Повторите действие.';
}
