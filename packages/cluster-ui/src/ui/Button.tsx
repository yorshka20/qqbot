import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

type Variant = 'quiet' | 'solid' | 'danger';

const VARIANT: Record<Variant, string> = {
  quiet: 'text-ink hover:bg-surface-2',
  solid: 'bg-ink text-bg hover:opacity-90',
  danger: 'text-failed hover:bg-surface-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'quiet', className = '', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1.5 rounded-ui px-3 py-1.5 text-14 font-medium whitespace-nowrap disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}

const CONFIRM_WINDOW_MS = 4000;

/** A destructive action asks by changing its own label, so nothing covers what it acts on. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  const click = () => {
    if (armed) {
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
  };

  return (
    <Button variant="danger" disabled={disabled} onClick={click}>
      {armed ? confirmLabel : label}
    </Button>
  );
}
