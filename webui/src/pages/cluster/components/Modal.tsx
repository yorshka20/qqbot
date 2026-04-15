import { X } from 'lucide-react';
import type { ReactNode } from 'react';

type Size = 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<Size, string> = {
  md: 'w-[min(95vw,56rem)] max-h-[75vh]',
  lg: 'w-[min(95vw,60rem)] max-h-[80vh]',
  xl: 'w-[min(95vw,72rem)] max-h-[90vh]',
};

interface ModalProps {
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  size?: Size;
  zIndex?: number;
}

export function Modal({ onClose, header, children, size = 'lg', zIndex = 50 }: ModalProps) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60"
      style={{ zIndex }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className={`bg-white dark:bg-zinc-900 rounded-xl shadow-2xl flex flex-col ${SIZE_CLASS[size]}`}>
        <div className="shrink-0 px-5 py-4 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
          <div className="flex-1 min-w-0 flex items-center gap-3">{header}</div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1 rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </div>
    </div>
  );
}
