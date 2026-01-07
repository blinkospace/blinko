# SSE Real-time Autocorrect Updates - Manual Testing

**Feature**: Real-time note updates via Server-Sent Events (SSE)
**Branch**: `feature/realtime-autocorrect-updates`
**Date**: 2026-01-07

## Test Environment

- **Backend**: `bun run dev:backend`
- **Frontend**: `bun run dev:frontend`
- **Browser**: Chrome/Firefox with DevTools

---

## Test 1: Basic SSE Connection

**Objective**: Verify SSE connection establishes successfully

**Steps**:
1. Start backend server: `bun run dev:backend`
2. Start frontend: `bun run dev:frontend`
3. Open application in browser
4. Open DevTools → Network tab
5. Filter for "EventSource" or look for `/api/sse/connect`

**Expected Results**:
- ✅ Connection to `/api/sse/connect` with status 200
- ✅ Type: `eventsource`
- ✅ Console log: `[SSE] Connected: ...`
- ✅ No toast notification on initial connection

**Status**: ⏳ Not tested

---

## Test 2: Autocorrection Flow

**Objective**: Verify autocorrected notes update automatically without refresh

**Prerequisites**:
- AI autocorrection configured in settings
- Custom mode enabled for autocorrection

**Steps**:
1. Ensure SSE connection is active (Test 1)
2. Create a new note with content that triggers autocorrection
3. Submit the note
4. Observe the UI (DO NOT refresh)

**Expected Results**:
- ✅ Server log: `[DEBUG] SSE broadcast sent for note: <noteId>`
- ✅ Browser console: `[SSE] Note updated: { noteId: X, timestamp: ... }`
- ✅ Browser console: `[BlinkoStore] Handling note update: <noteId>`
- ✅ Note content updates automatically in the UI
- ✅ Toast notification: "Note updated automatically" (or translated)

**Status**: ⏳ Not tested

---

## Test 3: Multiple Tabs

**Objective**: Verify all open tabs receive updates

**Steps**:
1. Open application in Tab 1
2. Open application in Tab 2 (same browser)
3. In Tab 1, create/edit a note with autocorrection
4. Observe Tab 2 (DO NOT interact with it)

**Expected Results**:
- ✅ Both tabs have active SSE connections
- ✅ Server shows 2 connections for the user
- ✅ Tab 2 receives note update event
- ✅ Tab 2 UI updates automatically
- ✅ Both tabs show toast notification

**Status**: ⏳ Not tested

---

## Test 4: Connection Reconnection

**Objective**: Verify auto-reconnection when connection drops

**Steps**:
1. Establish SSE connection (Test 1)
2. Stop the backend server
3. Observe browser console
4. Wait ~5 seconds
5. Restart backend server
6. Observe browser console

**Expected Results**:
- ✅ Console log: `[SSE] Connection error: ...`
- ✅ Console log: `[SSE] Reconnecting in <delay>ms (attempt 1/10)`
- ✅ Exponential backoff delays: 1s, 2s, 4s, 8s, etc.
- ✅ After restart: `[SSE] Connected: ...`
- ✅ Toast notification: "Connection restored" (on reconnection, not initial connection)
- ✅ `reconnectAttempts` resets to 0

**Status**: ⏳ Not tested

---

## Test 5: Max Reconnection Attempts

**Objective**: Verify max reconnection limit

**Steps**:
1. Establish SSE connection
2. Stop backend server permanently
3. Observe browser console for ~5 minutes

**Expected Results**:
- ✅ Attempts reconnection up to 10 times
- ✅ Console log: `[SSE] Max reconnection attempts reached`
- ✅ Toast notification: "Connection lost - real-time updates unavailable"
- ✅ No further reconnection attempts

**Status**: ⏳ Not tested

---

## Test 6: Connection Limits

**Objective**: Verify max 5 connections per user

**Steps**:
1. Open application in 6+ tabs simultaneously
2. Check server logs
3. Visit `/api/sse/stats` endpoint (requires auth)

**Expected Results**:
- ✅ Server log: `User <userId> exceeded max SSE connections`
- ✅ Oldest connection is closed
- ✅ Maximum 5 active connections per user
- ✅ Stats show correct counts

**Status**: ⏳ Not tested

---

## Test 7: Heartbeat

**Objective**: Verify heartbeat keeps connection alive

**Steps**:
1. Establish SSE connection
2. Let connection idle for 2+ minutes
3. Monitor browser DevTools Network tab
4. Check for heartbeat events every 30 seconds

**Expected Results**:
- ✅ EventSource connection stays open
- ✅ Heartbeat events received every ~30 seconds
- ✅ No disconnection or reconnection

**Status**: ⏳ Not tested

---

## Test 8: Note List Update

**Objective**: Verify note updates in list views

**Steps**:
1. Navigate to note list view
2. Trigger autocorrection on a visible note
3. Observe the note in the list

**Expected Results**:
- ✅ Note content updates in-place without page refresh
- ✅ No duplicate notes appear
- ✅ Note order remains stable
- ✅ UI re-renders correctly

**Status**: ⏳ Not tested

---

## Test 9: Selected Note Update

**Objective**: Verify currently selected/editing note updates

**Steps**:
1. Open a note for editing
2. In another tab or window, trigger autocorrection on the same note
3. Observe the editor

**Expected Results**:
- ✅ Editor content updates automatically
- ✅ Cursor position preserved (if possible)
- ✅ No data loss if user was editing

**Status**: ⏳ Not tested

**NOTE**: May need to add conflict resolution if user is actively editing.

---

## Test 10: Error Handling

**Objective**: Verify graceful error handling

**Steps**:
1. Temporarily break SSEService import in `aiServer/index.ts`
2. Trigger autocorrection
3. Check logs

**Expected Results**:
- ✅ Autocorrection still completes successfully
- ✅ Server log: `[DEBUG] Failed to broadcast SSE update: ...`
- ✅ Frontend doesn't receive update (expected)
- ✅ No server crash

**Status**: ⏳ Not tested

---

## Test 11: Authentication

**Objective**: Verify SSE requires authentication

**Steps**:
1. Logout of application
2. Try to access `/api/sse/connect` directly (via curl or browser)

**Expected Results**:
- ✅ Response: 401 Unauthorized
- ✅ No SSE connection established

**Status**: ⏳ Not tested

---

## Test 12: Cross-User Isolation

**Objective**: Verify users only receive their own updates

**Steps**:
1. Login as User A in Browser 1
2. Login as User B in Browser 2
3. User A creates/updates a note
4. Observe User B's browser

**Expected Results**:
- ✅ User B does NOT receive User A's updates
- ✅ Only note owner receives SSE broadcast
- ✅ No cross-user data leakage

**Status**: ⏳ Not tested

---

## Test 13: i18n Translations

**Objective**: Verify translations work in different languages

**Steps**:
1. Change app language to Chinese/Japanese/etc.
2. Disconnect and reconnect (stop/start backend)
3. Trigger autocorrection

**Expected Results**:
- ✅ "Connection restored" toast in selected language
- ✅ "Note updated automatically" toast in selected language
- ✅ No English fallbacks for supported languages

**Status**: ⏳ Not tested

---

## Test 14: Mobile/Background Behavior

**Objective**: Verify SSE disconnects on mobile background

**Steps**:
1. Open app on mobile device
2. Switch to background/home screen
3. Return to app after 1+ minute

**Expected Results**:
- ✅ SSE disconnects when app backgrounded
- ✅ Auto-reconnects when app foregrounded
- ✅ Toast shows "Connection restored"

**Status**: ⏳ Not tested

---

## Performance Tests

### Test 15: Memory Leaks

**Objective**: Verify no memory leaks

**Steps**:
1. Open browser DevTools → Performance → Memory
2. Take heap snapshot
3. Open/close app 10 times
4. Take another heap snapshot
5. Compare

**Expected Results**:
- ✅ No significant memory growth
- ✅ EventSource instances properly cleaned up
- ✅ No detached DOM nodes

**Status**: ⏳ Not tested

---

### Test 16: Server Resource Usage

**Objective**: Verify server handles connections efficiently

**Steps**:
1. Check `/api/sse/stats` with 1 user, 5 connections
2. Monitor server memory usage
3. Let run for 1 hour with periodic autocorrections

**Expected Results**:
- ✅ Stable memory usage
- ✅ Stats accurately report connections
- ✅ No connection leaks
- ✅ Heartbeat doesn't cause memory growth

**Status**: ⏳ Not tested

---

## Edge Cases

### Test 17: Note Without AccountId

**Objective**: Verify handling of notes without accountId

**Steps**:
1. If possible, create a note with `accountId = null`
2. Trigger autocorrection on that note
3. Check server logs

**Expected Results**:
- ✅ Server log: `[DEBUG] Skipping SSE broadcast: note has no accountId`
- ✅ No SSE broadcast attempted
- ✅ Autocorrection still completes

**Status**: ⏳ Not tested / N/A (if accountId is required)

---

### Test 18: Rapid Updates

**Objective**: Verify handling of rapid successive updates

**Steps**:
1. Trigger autocorrection on same note 3 times quickly
2. Observe UI and logs

**Expected Results**:
- ✅ All 3 SSE broadcasts sent
- ✅ UI updates for each change
- ✅ No race conditions or duplicate notes
- ✅ Final state is correct

**Status**: ⏳ Not tested

---

## Summary

**Total Tests**: 18
**Passed**: 0
**Failed**: 0
**Not Tested**: 18

---

## Test Results

_To be filled in after testing_

### Blocking Issues

_None identified yet_

### Non-blocking Issues

_None identified yet_

### Notes

_Additional observations during testing_

---

## Sign-off

- [ ] All critical tests passed
- [ ] No blocking issues
- [ ] Ready for code review
- [ ] Ready for merge to main

**Tester**: _________________
**Date**: _________________
