import { Router, Request, Response } from 'express';
import { SSEService } from '../lib/sseService';

const router = Router();

/**
 * SSE endpoint for real-time updates
 * Clients connect to this endpoint and receive events
 */
router.get('/sse/connect', (req: Request, res: Response) => {
  // Check if user is authenticated
  // @ts-ignore - Context is attached by middleware
  const userId = req.ctx?.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

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
});

/**
 * Debug endpoint to check SSE stats (optional, for development)
 */
router.get('/sse/stats', (req: Request, res: Response) => {
  const stats = SSEService.getStats();
  res.json(stats);
});

export default router;
