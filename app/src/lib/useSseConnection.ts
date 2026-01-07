import { useEffect, useRef } from 'react';
import { eventBus } from './event';
import { RootStore } from '@/store/root';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import i18n from './i18n';

/**
 * Hook to establish and manage SSE connection for real-time updates
 */
export function useSseConnection() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;

  useEffect(() => {
    let isActive = true;

    const connect = () => {
      if (!isActive) return;

      try {
        const eventSource = new EventSource('/api/sse/connect');
        eventSourceRef.current = eventSource;

        eventSource.addEventListener('connected', (event) => {
          console.log('[SSE] Connected:', event.data);
          reconnectAttempts.current = 0;

          // Show connection restored toast if this was a reconnection
          if (reconnectAttempts.current > 0) {
            RootStore.Get(ToastPlugin).success(i18n.t('connection-restored') || 'Connection restored');
          }
        });

        eventSource.addEventListener('note-updated', (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('[SSE] Note updated:', data);
            eventBus.emit('note-updated', data);
          } catch (error) {
            console.error('[SSE] Failed to parse note-updated event:', error);
          }
        });

        eventSource.addEventListener('heartbeat', () => {
          // Heartbeat received - connection is alive
        });

        eventSource.onerror = (error) => {
          console.error('[SSE] Connection error:', error);
          eventSource.close();

          // Attempt reconnection with exponential backoff
          if (reconnectAttempts.current < maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
            reconnectAttempts.current++;

            console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current}/${maxReconnectAttempts})`);

            reconnectTimeoutRef.current = setTimeout(() => {
              if (isActive) {
                connect();
              }
            }, delay);
          } else {
            console.error('[SSE] Max reconnection attempts reached');
            RootStore.Get(ToastPlugin).error(i18n.t('connection-lost') || 'Connection lost');
          }
        };
      } catch (error) {
        console.error('[SSE] Failed to establish connection:', error);
      }
    };

    // Initial connection
    connect();

    // Cleanup
    return () => {
      isActive = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, []);
}
