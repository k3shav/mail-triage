import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.kind === 'success' ? <IconCheck /> : toast.kind === 'error' ? <IconAlert /> : <IconInfo />}
          <span>{toast.text}</span>
          <button className="icon-btn" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}
