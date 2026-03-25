import express from 'express';
import { FileService } from '../../lib/files';
import { getTokenFromRequest } from '../../lib/helper';
import { Readable, PassThrough } from 'stream';
import busboy from 'busboy';
import cors from 'cors';

const router = express.Router();

router.options('/', cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*',
  maxAge: 86400,
}));

/**
 * @swagger
 * /api/file/upload:
 *   post:
 *     tags: 
 *       - File
 *     summary: Upload File
 *     operationId: uploadFile
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Upload File
 *             required:
 *               - file
 *     responses:
 *       200:
 *         description: Upload Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 Message:
 *                   type: string
 *                 status:
 *                   type: number
 *                 path:
 *                   type: string
 *                 type:
 *                   type: string
 *                 size:
 *                   type: number
 *       401:
 *         description: UNAUTH
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *     security:
 *       - bearer: []
 */
router.post('/', async (req, res) => {
  try {
    req.setTimeout(0); // 0 = no timeout
    res.setTimeout(0); // 0 = no timeout

    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: "Content type must be multipart/form-data" });
    }
    
    const bb = busboy({
      headers: req.headers
    });
    
    let fileInfo: {
      stream: PassThrough | null,
      filename: string,
      mimeType: string,
      size: number,
      isUserVoiceRecording?: boolean,
      audioDuration?: string,
      audioDurationSeconds?: number
    } | null = null;

    let isUserVoiceRecording = false;
    let audioDuration: string | null = null;
    let audioDurationSeconds: number | null = null;

    bb.on('field', (fieldname, value) => {
      if (fieldname === 'isUserVoiceRecording' && value === 'true') {
        isUserVoiceRecording = true;
      } else if (fieldname === 'audioDuration') {
        audioDuration = value;
      } else if (fieldname === 'audioDurationSeconds') {
        audioDurationSeconds = parseInt(value, 10);
      }
    });

    bb.on('file', (fieldname, stream, info) => {
      if (fieldname === 'file') {
        const passThrough = new PassThrough();
        let fileSize = 0;
        let decodedFilename: string;
        try {
          decodedFilename = Buffer.from(info.filename, 'binary').toString('utf-8');
        } catch {
          decodedFilename = info.filename;
        }
        // Fallback if decoding produced an empty or invalid string
        if (!decodedFilename || decodedFilename.trim() === '') {
          decodedFilename = info.filename || `upload_${Date.now()}`;
        }
        
        stream.on('data', (chunk) => {
          fileSize += chunk.length;
          passThrough.write(chunk);
        });
        
        stream.on('end', () => {
          passThrough.end();
          fileInfo = {
            stream: passThrough,
            filename: decodedFilename.replace(/\s+/g, "_"),
            mimeType: info.mimeType,
            size: fileSize,
            isUserVoiceRecording,
            audioDuration: audioDuration || undefined,
            audioDurationSeconds: audioDurationSeconds || undefined
          };
        });
      }
    });
    
    bb.on('finish', async () => {
      if (!fileInfo || !fileInfo.stream) {
        return res.status(400).json({ error: "No files received." });
      }
      
      try {
        const webReadableStream = Readable.toWeb(fileInfo.stream) as unknown as ReadableStream;
        
        // Build metadata object
        const metadata: any = {};
        if (fileInfo.isUserVoiceRecording) {
          metadata.isUserVoiceRecording = true;
        }
        if (fileInfo.audioDuration) {
          metadata.audioDuration = fileInfo.audioDuration;
        }
        if (fileInfo.audioDurationSeconds) {
          metadata.audioDurationSeconds = fileInfo.audioDurationSeconds;
        }

        const filePath = await FileService.uploadFileStream({
          stream: webReadableStream,
          originalName: fileInfo.filename,
          fileSize: fileInfo.size,
          type: fileInfo.mimeType,
          accountId: Number(token.id),
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined
        });
        
        res.set({
          'Access-Control-Allow-Origin': req.headers.origin || '',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true'
        });
        
        res.status(200).json({
          Message: "Success",
          status: 200,
          ...filePath,
          type: fileInfo.mimeType,
          size: fileInfo.size
        });
      } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: "Upload failed" });
      }
    });
    
    req.pipe(bb);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
