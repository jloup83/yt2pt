/**
 * SSE composable. The full `/api/events` wiring (typed event map, cleanup
 * on route change, reconnect with backoff) lands with #67. Ships now so
 * later pages can import from a stable path.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export interface UseEventsReturn {
  connected: Ref<boolean>;
  close: () => void;
}

export function useEvents(_handlers: Record<string, (data: unknown) => void> = {}): UseEventsReturn {
  const connected = ref(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _noop = _handlers;

  const close = (): void => {
    connected.value = false;
  };
  onScopeDispose(close);

  return { connected, close };
}
