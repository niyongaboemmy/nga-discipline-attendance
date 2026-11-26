import type { RfidStreamEvent } from '../api/rfid';
import { useEventStream, type StreamState } from './useEventStream';

export type { StreamState };

/** Live check-in events from /api/rfid/stream (see useEventStream). */
export function useRfidStream(
  onEvent: (e: RfidStreamEvent) => void,
  opts: { enabled?: boolean; onReconnect?: () => void } = {}
): StreamState {
  return useEventStream<RfidStreamEvent>('/api/rfid/stream', onEvent, opts);
}
