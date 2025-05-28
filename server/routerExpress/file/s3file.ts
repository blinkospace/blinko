import express, { Request, Response } from 'express';
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FileService } from "../../lib/files";
import sharp from "sharp";
import mime from "mime-types";

const router = express.Router();

const MAX_PRESIGNED_URL_EXPIRY = 604800 - (60 * 60 * 24);
const CACHE_DURATION = MAX_PRESIGNED_URL_EXPIRY;

function isImage(filename: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  return imageExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

async function generateThumbnail(s3ClientInstance: any, config: any, fullPath: string) {
  try {
    const command = new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: decodeURIComponent(fullPath)
    });

    const response = await s3ClientInstance.send(command);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const metadata = await sharp(buffer).metadata();
    const { width = 0, height = 0 } = metadata;

    let resizeWidth = width;
    let resizeHeight = height;
    const maxDimension = 500;

    if (width > height && width > maxDimension) {
      resizeWidth = maxDimension;
      resizeHeight = Math.round(height * (maxDimension / width));
    } else if (height > maxDimension) {
      resizeHeight = maxDimension;
      resizeWidth = Math.round(width * (maxDimension / height));
    }

    const thumbnail = await sharp(buffer, {
      failOnError: false,
      limitInputPixels: false
    })
      .rotate()
      .resize(resizeWidth, resizeHeight, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: true
      })
      .toBuffer();

    return thumbnail;
  } catch (error) {
    console.error('Thumbnail generation error:', error);
    throw error;
  }
}

/**
 * @swagger
 * /api/s3file/{path}:
 *   get:
 *     tags: 
 *       - File
 *     summary: Get S3 File
 *     operationId: getS3File
 *     parameters:
 *       - in: path
 *         name: path
 *         schema:
 *           type: string
 *         required: true
 *         description: Path to the S3 file
 *       - in: query
 *         name: thumbnail
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Whether to return a thumbnail (only for images)
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *     security:
 *       - bearer: []
 */
const MAX_S3_OBJECT_AGE_SECONDS = 60 * 60 * 24 * 1; // 缓存1天 (示例)
//@ts-ignore
// router.get(/.*/, async (req: Request, res: Response) => {
//   try {
    
//     const { s3ClientInstance, config } = await FileService.getS3Client();
//     const fullPath = decodeURIComponent(req.path.substring(1));
//     const needThumbnail = req.query.thumbnail === 'true';

//     console.log('fullPath！！！！！！!!', decodeURIComponent(fullPath));

//     if (isImage(fullPath) && needThumbnail) {
//       try {
//         const thumbnail = await generateThumbnail(s3ClientInstance, config, fullPath);
//         const filename = decodeURIComponent(fullPath.split('/').pop() || '');

//         res.set({
//           "Content-Type": mime.lookup(filename) || "image/jpeg",
//           "Cache-Control": "public, max-age=31536000",
//           "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
//           "X-Content-Type-Options": "nosniff",
//         });

//         return res.send(thumbnail);
//       } catch (error) {
//         console.error('Failed to generate thumbnail, falling back to original:', error);
//         const command = new GetObjectCommand({
//           Bucket: config.s3Bucket,
//           Key: decodeURIComponent(fullPath),
//           ResponseCacheControl: `public, max-age=${CACHE_DURATION}, immutable`,
//         });

//         console.log('Bucket:', config.s3Bucket);
//         console.log('Key:', decodeURIComponent(fullPath));
//         const signedUrl = await getSignedUrl(s3ClientInstance as any, command as any, {
//           expiresIn: MAX_PRESIGNED_URL_EXPIRY,
//         });

//         console.log('Signed URL:', signedUrl);

//         return res.redirect(signedUrl);
//       }
//     }
//     console.log('fullPath!!', decodeURIComponent(fullPath));
//     //@important if @aws-sdk/client-s3 is not 3.693.0, has 403 error
//     const command = new GetObjectCommand({
//       Bucket: config.s3Bucket,
//       Key: decodeURIComponent(fullPath),
//       ResponseCacheControl: `public, max-age=${CACHE_DURATION}, immutable`
//     });

//     const signedUrl = await getSignedUrl(s3ClientInstance as any, command as any, {
//       expiresIn: MAX_PRESIGNED_URL_EXPIRY
//     });

//     // res.set({
//     //   'Cache-Control': `public, max-age=${CACHE_DURATION}, immutable`,
//     //   'Expires': new Date(Date.now() + CACHE_DURATION * 1000).toUTCString()
//     // });

//     return res.redirect(signedUrl);
//   } catch (error) {
//     console.error('S3 file access error:', error);
//     return res.status(404).json({
//       error: 'File not found',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// });
router.get(/.*/, async (req: Request, res: Response) => {
  try {
    const { s3ClientInstance, config } = await FileService.getS3Client();
    const fullPath = decodeURIComponent(req.path.substring(1));
    const needThumbnail = req.query.thumbnail === 'true';
    const filename = decodeURIComponent(fullPath.split('/').pop() || 'file'); // 用于 Content-Disposition

    if (isImage(fullPath) && needThumbnail) {
      try {
        const thumbnailBuffer = await generateThumbnail(s3ClientInstance, config, fullPath);
        const thumbnailFilename = `thumbnail-${filename}`;

        res.set({
          "Content-Type": mime.lookup(thumbnailFilename) || "image/jpeg",
          "Cache-Control": `public, max-age=${MAX_S3_OBJECT_AGE_SECONDS}, immutable`,
          "Expires": new Date(Date.now() + MAX_S3_OBJECT_AGE_SECONDS * 1000).toUTCString(),
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(thumbnailFilename)}`,
          "X-Content-Type-Options": "nosniff",
        });
        return res.send(thumbnailBuffer);
      } catch (error) {
        console.error('生成缩略图失败，将提供原图:', error);
        // 如果缩略图失败，则继续执行下面的代码来提供原图
      }
    }

    // 非缩略图请求，或缩略图生成失败
    const command = new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: fullPath, // S3 Key 通常不需要再次 decodeURIComponent，因为它在 fullPath 中已经处理
      // 注意：这里不再需要 ResponseCacheControl 或 ResponseContentDisposition
      // 因为是我们的服务器直接发送响应头
    });

    const s3Object = await s3ClientInstance.send(command);

    // 从 S3 获取元数据来设置响应头
    const contentType = s3Object.ContentType || mime.lookup(fullPath) || "application/octet-stream";
    const contentLength = s3Object.ContentLength;
    const eTag = s3Object.ETag;
    const lastModified = s3Object.LastModified;

    res.set({
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${MAX_S3_OBJECT_AGE_SECONDS}, immutable`, // 让浏览器缓存文件内容
      "Expires": new Date(Date.now() + MAX_S3_OBJECT_AGE_SECONDS * 1000).toUTCString(),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`, // inline 或 attachment
      "X-Content-Type-Options": "nosniff",
    });

    if (contentLength) {
      res.set("Content-Length", contentLength.toString());
    }
    if (eTag) {
      res.set("ETag", eTag);
    }
    if (lastModified) {
      res.set("Last-Modified", lastModified.toUTCString());
    }

    // 检查 s3Object.Body 是否存在并且是可读流
    if (s3Object.Body && typeof (s3Object.Body as any).pipe === 'function') {
      // 将 S3 对象的可读流管道连接到 Express 的响应流
      (s3Object.Body as Readable).pipe(res);
    } else if (s3Object.Body) { // 如果 Body 是 Uint8Array 或其他类型 (例如浏览器环境的 ReadableStream)
        // 对于 Uint8Array (有时 SDK 会返回这个，取决于环境和配置)
        if (s3Object.Body instanceof Uint8Array) {
            return res.send(Buffer.from(s3Object.Body)); // 转换为 Node.js Buffer 发送
        }
        // 如果是 Web API ReadableStream，需要转换为 Node.js Readable stream 或读取所有数据
        // 简单起见，这里假设 Body 主要是 Node.js Readable 或 Uint8Array
        console.error('S3 object body is not a directly pipeable Node.js stream or Uint8Array.');
        return res.status(500).json({ error: 'Failed to stream file', details: 'Unsupported S3 object body type' });
    } else {
      console.error('S3 object body is undefined.');
      return res.status(404).json({ error: 'File content not found in S3 response' });
    }

  } catch (error: any) {
    console.error('S3 file access error (proxy mode):', error);
    if (error.name === 'NoSuchKey' || (error.$metadata && error.$metadata.httpStatusCode === 404)) {
      return res.status(404).json({
        error: 'File not found',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
    return res.status(500).json({
      error: 'Internal server error while fetching file',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;

