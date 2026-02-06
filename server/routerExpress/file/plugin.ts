import express from 'express';
import { createReadStream } from 'fs';
import { join, resolve } from 'path';
import pathIsInside from 'path-is-inside';
import sanitizeFilename from 'sanitize-filename';

const router = express.Router();

// Resolved base directory for plugins - prevents path traversal
const PLUGIN_BASE_DIR = resolve(join('.blinko', 'plugins'));

/**
 * @swagger
 * /api/plugins/{path}:
 *   get:
 *     tags: 
 *       - Plugin
 *     summary: Get Plugin File
 *     operationId: getPluginFile
 *     parameters:
 *       - in: path
 *         name: path
 *         schema:
 *           type: string
 *         required: true
 *         description: Path to the plugin file
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/javascript:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid path
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       404:
 *         description: Plugin not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
//@ts-ignore
router.get(/(.*)/, (req, res) => {
  try {
    const pathArray = req.params[0].split('/').filter(Boolean);

    // Security: Check for path traversal attempts in each path component
    for (const part of pathArray) {
      if (part === '..' || part === '.' || part.includes('..')) {
        return res.status(400).json({ error: 'Invalid path: path traversal detected' });
      }
      // Sanitize each component and reject if it was modified
      const sanitized = sanitizeFilename(part, { replacement: '_' });
      if (sanitized !== part) {
        return res.status(400).json({ error: 'Invalid path: contains dangerous characters' });
      }
    }

    const filePath = join('.blinko', 'plugins', ...pathArray);
    const resolvedPath = resolve(filePath);

    // Security: Ensure the resolved path is inside the plugin directory
    if (!pathIsInside(resolvedPath, PLUGIN_BASE_DIR)) {
      return res.status(400).json({ error: 'Invalid path: outside plugin directory' });
    }

    const stream = createReadStream(resolvedPath);
    res.set('Content-Type', 'application/javascript');
    stream.on('error', (error) => {
      console.error('Error reading plugin file:', error);
      if (!res.headersSent) {
        res.status(404).json({ error: 'Plugin not found' });
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error('Error serving plugin file:', error);
    res.status(404).json({ error: 'Plugin not found' });
  }
});

export default router;
