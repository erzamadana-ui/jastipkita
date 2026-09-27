/**
 * Dense data table: semantic <table>, sortable headers (aria-sort; sorts the loaded page — the API orders
 * server-side), keyboard-activatable rows (Enter/Space), cursor pagination (API `nextCursor`), loading/empty/error.
 */
import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { describeError } from '../api/errors';
import type { Page } from '../api/types';
import { Icon } from './Icon';
import { Button, Callout, cx, EmptyState, Skeleton } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  width?: number | string;
  className?: string;
}

export interface Pagination {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  fetching?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: string; body?: ReactNode };
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  caption: string;
  pagination?: Pagination;
  compact?: boolean;
}

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, empty, onRowClick, rowLabel, rowClassName, caption, pagination, compact }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const sorted = useMemo(() => {
    if (!rows || !sort) return rows ?? [];
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const val = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'id');
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));

  return (
    <div>
      {error ? (
        <div style={{ padding: 16 }}>
          <Callout tone="danger" title="Gagal memuat data.">
            {describeError(error).title} {describeError(error).detail ? <span className="small">({describeError(error).detail})</span> : null}{' '}
            {onRetry ? (
              <Button size="sm" onClick={onRetry} icon="refresh">
                Coba lagi
              </Button>
            ) : null}
          </Callout>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className={cx('table', compact && 'table--compact')}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={cx(c.align === 'right' && 'num', c.className)}
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={c.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  >
                    {c.sortValue ? (
                      <button type="button" className="sort" onClick={() => toggle(c.key)}>
                        {c.header}
                        <Icon name={active ? (sort!.dir === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort'} size={12} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && !rows?.length
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={`sk${i}`}>
                    {columns.map((c) => (
                      <td key={c.key}>
                        <Skeleton width={`${50 + ((i * 7 + c.key.length * 5) % 45)}%`} />
                      </td>
                    ))}
                  </tr>
                ))
              : sorted.map((r) => (
                  <tr
                    key={rowKey(r)}
                    className={cx(onRowClick && 'clickable', rowClassName?.(r))}
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-label={onRowClick && rowLabel ? rowLabel(r) : undefined}
                    onClick={onRowClick ? (e) => !(e.target as HTMLElement).closest('button,a,input,select,textarea') && onRowClick(r) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                              e.preventDefault();
                              onRowClick(r);
                            }
                          }
                        : undefined
                    }
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={cx(c.align === 'right' && 'num', c.className)}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && rows && rows.length === 0 ? <EmptyState title={empty?.title ?? 'Tidak ada data'}>{empty?.body}</EmptyState> : null}
      {pagination && (pagination.hasPrev || pagination.hasNext) ? (
        <nav className="pager" aria-label={`Paginasi ${caption}`}>
          <span>
            Halaman {pagination.page}
            {pagination.fetching ? ' · memuat…' : ''}
          </span>
          <span className="btn-group">
            <Button size="sm" icon="chevron-left" onClick={pagination.onPrev} disabled={!pagination.hasPrev}>
              Sebelumnya
            </Button>
            <Button size="sm" onClick={pagination.onNext} disabled={!pagination.hasNext}>
              Berikutnya <Icon name="chevron-right" size={14} />
            </Button>
          </span>
        </nav>
      ) : null}
    </div>
  );
}

/** Cursor pagination over a `{data, nextCursor}` endpoint; resets to page 1 whenever `key` (filters) changes. */
export function useCursorQuery<T>(key: QueryKey, fetcher: (cursor: string | undefined) => Promise<Page<T>>, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const keyStr = JSON.stringify(key);
  const [state, setState] = useState<{ k: string; stack: (string | undefined)[] }>({ k: keyStr, stack: [undefined] });
  const stack = state.k === keyStr ? state.stack : [undefined];
  const cursor = stack[stack.length - 1];
  const q = useQuery({
    queryKey: [...key, { cursor: cursor ?? null }],
    queryFn: () => fetcher(cursor),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
  });
  const next = q.data?.nextCursor ?? null;
  const pagination: Pagination = {
    page: stack.length,
    hasPrev: stack.length > 1,
    hasNext: !!next,
    fetching: q.isFetching,
    onNext: () => next && setState({ k: keyStr, stack: [...stack, next] }),
    onPrev: () => setState({ k: keyStr, stack: stack.slice(0, -1) }),
  };
  return { query: q, rows: q.data?.data, pagination };
}
