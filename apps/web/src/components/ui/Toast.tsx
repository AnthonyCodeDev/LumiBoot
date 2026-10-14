import { useToastStore } from '../../features/ui/toast.store';

export function Toast() {
  const message = useToastStore((state) => state.message);
  const visible = useToastStore((state) => state.visible);
  return (
    <div className={`toast${visible ? ' show' : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
