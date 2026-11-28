import express from 'express';
import { generateFeed } from '../lib/helper';

const router = express.Router();

router.get('/:userId/rss', async (req, res) => {
  try {
    const userId = req.params.userId;
    const rows = req.query.row ? parseInt(req.query.row as string) : 20;
    const fullOrigin = new URL(process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || 'http://localhost:1111').origin;
    const feed = await generateFeed(Number(userId), fullOrigin, rows);
    res.set({
      'Content-Type': 'application/rss+xml; charset=UTF-8',
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(feed.rss2());
  } catch (error) {
    console.error('Error generating RSS feed:', error);
    return res.status(500).json({ error: 'Failed to generate RSS feed' });
  }
});

router.get('/:userId/atom', async (req, res) => {
  try {
    const userId = req.params.userId;
    const rows = req.query.row ? parseInt(req.query.row as string) : 20;
    const fullOrigin = new URL(process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || 'http://localhost:1111').origin;
    const feed = await generateFeed(Number(userId), fullOrigin, rows);
    res.set({
      'Content-Type': 'application/atom+xml; charset=UTF-8',
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(feed.atom1());
  } catch (error) {
    console.error('Error generating ATOM feed:', error);
    return res.status(500).json({ error: 'Failed to generate ATOM feed' });
  }
});

export default router;
