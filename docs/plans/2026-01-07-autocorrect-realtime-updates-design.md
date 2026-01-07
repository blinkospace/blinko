# Real-time Note Updates After AI Autocorrection

**Date:** 2026-01-07
**Status:** Approved
**Problem:** Users must manually refresh to see AI-autocorrected notes

## Overview

Add Server-Sent Events (SSE) to push note updates to the frontend when AI autocorrection completes. This eliminates manual refreshes and provides instant feedback.

## Architecture

### Flow
1. User creates/edits note → tRPC mutation returns immediately
2. Backend processes autocorrection asynchronously (`postProcessNote`)
3. When autocorrection completes → broadcast update via SSE
4. Frontend receives event → refetches specific note
5. UI updates automatically

### Why SSE over WebSockets
- Simpler implementation (standard HTTP, no upgrade handshake)
- Built-in auto-reconnection
- Unidirectional communication (server→client) is sufficient
- Better fit for existing Express/tRPC architecture

## Backend Implementation

### 1. SSE Service (`server/lib/sseService.ts`)

**Purpose:** Manage SSE connections and broadcast events

**API:**
```typescript
class SSEService {
  // Store: Map<userId, Set<Response>>
  private connections: Map<number, Set<Response>>

  connect(userId: number, res: Response): void
  disconnect(userId: number, res: Response): void
  broadcast(userId: number, event: string, data: any): void
  broadcastNoteUpdate(userId: number, noteId: number): void
  cleanup(): void // Remove dead connections
}
```

**Features:**
- Max 5 connections per user (prevent resource exhaustion)
- Heartbeat every 30s to detect dead connections
- Auto-cleanup on disconnect

### 2. SSE Express Route (`server/routerExpress/sse.ts`)

**Endpoint:** `GET /api/sse/connect`

**Implementation:**
```typescript
router.get('/api/sse/connect', authenticate, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // Register connection
  SSEService.connect(req.user.id, res)

  // Handle disconnect
  req.on('close', () => SSEService.disconnect(req.user.id, res))

  // Send initial connection event
  res.write('data: {"type":"connected"}\n\n')
})
```

**Security:**
- Extract JWT/session from request
- Rate limit: max 1 connection/second per user
- CSRF protection in handshake

### 3. Integration with AI Processing

**Location:** `server/aiServer/index.ts:348` (`postProcessNote`)

**Changes:**
```typescript
// After successful autocorrection (line ~443)
if (processingMode === 'custom') {
  await upsertBlinkoTool.execute(...)

  // NEW: Broadcast update via SSE
  const SSEService = await import('../lib/sseService')
  SSEService.default.broadcastNoteUpdate(note.accountId, noteId)

  return { success: true, message: 'Custom processing completed' }
}
```

**Event Format:**
```json
{
  "type": "note-updated",
  "noteId": 123,
  "timestamp": "2026-01-07T..."
}
```

## Frontend Implementation

### 1. SSE Hook (`app/src/lib/useSseConnection.ts`)

**Purpose:** Establish and manage SSE connection

**Implementation:**
```typescript
export function useSseConnection() {
  useEffect(() => {
    const eventSource = new EventSource('/api/sse/connect')

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data)
      eventBus.emit('sse-event', data)
    }

    eventSource.addEventListener('note-updated', (event) => {
      const { noteId } = JSON.parse(event.data)
      eventBus.emit('note-updated', { noteId })
    })

    eventSource.onerror = (error) => {
      // Auto-reconnects with exponential backoff
      console.error('SSE error:', error)
    }

    return () => eventSource.close()
  }, [])
}
```

**Features:**
- Auto-reconnection (built into EventSource)
- Exponential backoff on errors
- Toast notifications on connection lost/restored

### 2. BlinkoStore Integration

**Location:** `app/src/store/blinkoStore.tsx`

**Changes:**

1. Add listener in constructor:
```typescript
constructor() {
  // ... existing code

  eventBus.on('note-updated', this.handleNoteUpdate)
}
```

2. Add handler method:
```typescript
handleNoteUpdate = async (data: { noteId: number }) => {
  const { noteId } = data

  // Refetch note details
  const updated = await api.notes.detail.query({ id: noteId })

  // Update in list view if present
  if (this.noteListInfiniteQuery.data) {
    const pages = this.noteListInfiniteQuery.data.pages
    for (const page of pages) {
      const index = page.notes.findIndex(n => n.id === noteId)
      if (index !== -1) {
        page.notes[index] = updated
        break
      }
    }
  }

  // Update currently selected note if editing
  if (this.curSelectedNote?.id === noteId) {
    this.curSelectedNote = updated
  }

  // Show toast notification
  RootStore.Get(ToastPlugin).success(
    i18n.t('note-auto-updated')
  )
}
```

### 3. App Integration

**Location:** Main app component

**Changes:**
```typescript
function App() {
  useSseConnection() // Establish SSE on mount

  // ... rest of app
}
```

## Error Handling

### Connection Failures
- **SSE unavailable**: App degrades gracefully (no auto-updates)
- **Connection dropped**: Auto-reconnect with backoff
- **Multiple tabs**: Each gets own connection (all update)

### Edge Cases
1. **Update for deleted note**: Check existence before updating UI
2. **Offline mode**: SSE disconnects, reconnects when online
3. **Mobile background**: Auto-disconnect/reconnect on app lifecycle

### Security
- Verify user owns note before broadcasting
- Rate limiting prevents connection spam
- CSRF protection on endpoint
- Max connections per user enforced

## Testing Strategy

### Unit Tests
- Mock EventSource in frontend tests
- Test SSEService connection management
- Test broadcast logic with multiple clients

### Integration Tests
- Test full flow: create note → autocorrect → SSE update
- Test reconnection scenarios
- Test concurrent updates from multiple users

### Manual Testing
- Open multiple tabs, verify all update
- Kill connection, verify reconnection
- Test on mobile (foreground/background)

## Performance Considerations

- SSE connections are lightweight (HTTP long-polling alternative)
- Memory: ~1KB per connection (max 5 per user)
- Heartbeat prevents zombie connections
- No polling overhead on frontend

## Rollout Plan

1. Implement SSE service and route
2. Add SSE integration to postProcessNote
3. Implement frontend hook and integration
4. Test with feature flag (optional)
5. Monitor connection counts and error rates
6. Full rollout

## Future Enhancements

- Queue missed updates during disconnection
- Batch updates for bulk operations
- Real-time collaboration features
- Presence indicators (who's viewing/editing)
