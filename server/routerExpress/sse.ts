import express from 'express';
import { SSEService } from '../lib/sseService';
import { getTokenFromRequest } from '../lib/helper';

const router = express.Router();

/**
 * SSE endpoint for real-time updates
 * Clients connect to this endpoint and receive events
 */
router.get('/sse/connect', async (req, res) => {
  try {
    // Check if user is authenticated
    const token = await getTokenFromRequest(req);

    if (!token || !token.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = Number(token.id);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Register connection
    SSEService.connect(userId, res);

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      SSEService.disconnect(userId, res);
    });
  } catch (error) {
    console.error('SSE connection error:', error);
    res.status(500).json({ error: 'Failed to establish SSE connection' });
  }
});

/**
 * Debug endpoint to check SSE stats (optional, for development)
 */
router.get('/sse/stats', async (req, res) => {
  try {
    // Check if user is authenticated
    const token = await getTokenFromRequest(req);

    if (!token || !token.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const stats = SSEService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('SSE stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve SSE stats' });
  }
});

export default router;
