import express from 'express';
import { FileService } from '../../lib/files';
import { getTokenFromRequest } from '../../lib/helper';
import { prisma } from '../../prisma';

const router = express.Router();

/**
 * @swagger
 * /api/file/delete:
 *   post:
 *     tags: 
 *       - File
 *     summary: Delete File
 *     operationId: deleteFile
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               attachment_path:
 *                 type: string
 *                 description: File path (example - /api/file/123.png)
 *             required:
 *               - attachment_path
 *     responses:
 *       200:
 *         description: Delete Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 Message:
 *                   type: string
 *                 status:
 *                   type: number
 *     security:
 *       - bearer: []
 */
router.post('/', async (req, res) => {
  try {
    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const { attachment_path } = req.body;
    
    if (!attachment_path) {
      return res.status(400).json({ error: "Missing attachment_path parameter" });
    }

    // Security fix: Check user permissions before deleting file
    const attachment = await prisma.attachments.findFirst({
      where: { path: attachment_path },
      include: {
        note: {
          select: {
            accountId: true
          }
        }
      }
    });

    if (!attachment) {
      return res.status(404).json({ error: "File not found" });
    }

    // Check if user owns the file or the note containing the file
    const isOwner = attachment.accountId === Number(token.id) || 
                    attachment.note?.accountId === Number(token.id) ||
                    token.role === 'superadmin';

    if (!isOwner) {
      return res.status(403).json({ error: "Forbidden: You don't have permission to delete this file" });
    }
    
    await FileService.deleteFile(attachment_path);
    return res.status(200).json({ Message: "Success", status: 200 });
  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
