import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeError } from '../api/errors';
import { Icon } from './Icon';

export interface ToastInput {
  tone?: 'success' | 'error' | 'info';
  title: string;
  detail?: string | null;
  timeoutMs?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}
interface ToastApi {
  toast: (t: ToastInput) => void;
  error: (e: unknown, context?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const ms = t.timeoutMs ?? (t.tone === 'error' ? 9000 : 5000);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const error = useCallback(
    (e: unknown, context?: string) => {
      const d = describeError(e);
      toast({ tone: 'error', title: context ? `${context}: ${d.title}` : d.title, detail: d.detail });
    },
    [toast],
  );
  const api = useMemo(() => ({ toast, error }), [toast, error]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone ?? 'info'}`} role={t.tone === 'error' ? 'alert' : undefined}>
            <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'success' ? 'check' : 'info'} />
            <div>
              <div className="toast__title">{t.title}</div>
              {t.detail ? <div className="toast__detail">{t.detail}</div> : null}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Tutup notifikasi">
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
