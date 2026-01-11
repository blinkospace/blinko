import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getGlobalConfig } from "../routerTrpc/config";
import { UPLOAD_FILE_PATH, TEMP_PATH } from "@shared/lib/pathConstant";
import fs, { unlink, writeFile } from 'fs/promises';
import path from 'path';
import { cache } from "@shared/lib/cache";
import { prisma } from "../prisma";
import { Readable } from 'stream';
import { Upload } from "@aws-sdk/lib-storage";
import { PassThrough } from 'stream';
import { createWriteStream } from "fs";
import pathIsInside from 'path-is-inside';
import sanitizeFilename from 'sanitize-filename';

export class FileService {
  /**
   * Validates and sanitizes a file path to prevent path traversal attacks
   * @param inputPath - The input path to validate (relative path from API endpoint)
   * @param baseDir - The base directory that the path must be within (default: UPLOAD_FILE_PATH)
   * @param allowTemp - Whether to allow paths in the temp directory
   * @returns The validated and sanitized absolute file path
   * @throws Error if the path is invalid or outside the allowed directory
   */
  public static validateAndResolvePath(
    inputPath: string,
    baseDir: string = UPLOAD_FILE_PATH,
    allowTemp: boolean = false
  ): string {
    // Check for path traversal attempts
    if (inputPath.includes('..') || inputPath.includes('\\..') || inputPath.includes('/..')) {
      throw new Error('Invalid path: path traversal detected');
    }

    // Sanitize each path component (filename) separately
    const pathParts = inputPath.split(/[/\\]/);
    const sanitizedParts = pathParts.map(part => {
      if (part === '' || part === '.') return part;
      return sanitizeFilename(part, { replacement: '_' });
    });
    const sanitizedPath = sanitizedParts.join('/');
    
    // Check if sanitization changed the path (indicates dangerous characters)
    if (sanitizedPath !== inputPath.replace(/\\/g, '/')) {
      throw new Error('Invalid path: contains dangerous characters');
    }

    // Remove leading slashes and normalize
    const cleanedPath = sanitizedPath.replace(/^[./\\]+/, '');
    const resolvedBaseDir = path.resolve(baseDir);
    const resolvedFilePath = path.resolve(baseDir, cleanedPath);

    // Validate path is within allowed directory
    if (!pathIsInside(resolvedFilePath, resolvedBaseDir)) {
      throw new Error('Invalid path: outside allowed directory');
    }

    // For temp/ paths, ensure they are within the temp directory
    if (cleanedPath.includes('temp/') || cleanedPath.startsWith('temp/')) {
      if (!allowTemp) {
        throw new Error('Invalid path: temp directory access not allowed');
      }
      const resolvedTempDir = path.resolve(TEMP_PATH);
      if (!pathIsInside(resolvedFilePath, resolvedTempDir)) {
        throw new Error('Invalid path: temp path outside temp directory');
      }
    }

    return resolvedFilePath;
  }

  /**
   * Extracts and validates file path from API path
   * @param apiPath - API path like '/api/file/path/to/file.jpg' or '/api/s3file/path/to/file.jpg'
   * @param baseDir - Base directory for validation
   * @param allowTemp - Whether to allow temp directory access
   * @returns The validated absolute file path
   */
  public static extractAndValidatePath(
    apiPath: string,
    baseDir: string = UPLOAD_FILE_PATH,
    allowTemp: boolean = false
  ): string {
    let filePath = apiPath;
    if (apiPath.includes('/api/file/')) {
      filePath = apiPath.replace('/api/file/', '');
    } else if (apiPath.includes('/api/s3file/')) {
      // For S3 files, we only validate the path structure, not the actual file location
      filePath = apiPath.replace('/api/s3file/', '');
      // Basic validation for S3 paths
      if (filePath.includes('..') || filePath.includes('\\..') || filePath.includes('/..')) {
        throw new Error('Invalid S3 path: path traversal detected');
      }
      return filePath; // Return relative path for S3
    }

    return this.validateAndResolvePath(filePath, baseDir, allowTemp);
  }
  
  public static async getS3Client() {
    const config = await getGlobalConfig({ useAdmin: true });
    return cache.wrap(`${config.s3Endpoint}-${config.s3Region}-${config.s3Bucket}-${config.s3AccessKeyId}-${config.s3AccessKeySecret}`, async () => {
      const s3ClientInstance = new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        credentials: {
          accessKeyId: config.s3AccessKeyId,
          secretAccessKey: config.s3AccessKeySecret,
        },
        forcePathStyle: true,
      });
      return { s3ClientInstance, config };
    }, { ttl: 60 * 60 * 86400 * 1000 })
  }

  private static async writeFileSafe(baseName: string, extension: string, buffer: Buffer, attempt: number = 0) {
    const MAX_ATTEMPTS = 20;
    const config = await getGlobalConfig({ useAdmin: true });

    if (attempt >= MAX_ATTEMPTS) {
      throw new Error('MAX_ATTEMPTS_REACHED');
    }

    const sanitizeFileName = (name: string) => {
      try {
        const decodedName = decodeURIComponent(name);
        return decodedName
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_');
      } catch (error) {
        return name
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_');
      }
    };

    let filename = attempt === 0 ?
      `${sanitizeFileName(baseName)}${extension}` :
      `${sanitizeFileName(baseName)}_${Date.now()}${extension}`;

    let customPath = config.localCustomPath || '/';
    if (customPath) {
      customPath = customPath.startsWith('/') ? customPath : '/' + customPath;
      customPath = customPath.endsWith('/') ? customPath : customPath + '/';
    }

    try {
      const relativePath = `${customPath}${filename}`.replace(/^\//, '');
      const filePath = this.validateAndResolvePath(relativePath);
      await fs.access(filePath);
      return this.writeFileSafe(baseName, extension, buffer, attempt + 1);
    } catch (error) {
      const relativePath = `${customPath}${filename}`.replace(/^\//, '');
      const filePath = this.validateAndResolvePath(relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        //@ts-ignore
        await writeFile(filePath, buffer);
      } catch (error) {
        console.error('Error writing file:', error);
        throw error;
      }
      return relativePath;
    }
  }

  static async uploadFile({
    buffer, originalName, type, withOutAttachment = false, accountId, metadata
  }: {
    buffer: Buffer, originalName: string, type: string, withOutAttachment?: boolean, accountId: number, metadata?: any
  }) {
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const timestamp = Date.now();
    const config = await getGlobalConfig({ useAdmin: true });

    if (config.objectStorage === 's3') {
      const { s3ClientInstance } = await this.getS3Client();

      let customPath = config.s3CustomPath || '';
      if (customPath) {
        customPath = customPath.startsWith('/') ? customPath : '/' + customPath;
        customPath = customPath.endsWith('/') ? customPath : customPath + '/';
      }

      const timestampedFileName = `${baseName}_${timestamp}${extension}`;
      const s3Key = `${customPath}${timestampedFileName}`.replace(/^\//, '');

      const command = new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: s3Key,
        Body: buffer,
      });

      await s3ClientInstance.send(command);
      const s3Url = `/api/s3file/${s3Key}`;
      if (!withOutAttachment) {
        await FileService.createAttachment({
          path: s3Url,
          name: FileService.getOriginFilename(timestampedFileName),
          size: buffer.length,
          type,
          accountId,
          metadata
        });
      }
      return { filePath: s3Url, fileName: FileService.getOriginFilename(timestampedFileName) };
    } else {
      const filename = await this.writeFileSafe(baseName, extension, buffer);
      await FileService.createAttachment({
        path: `/api/file/${filename}`,
        name: FileService.getOriginFilename(filename),
        size: buffer.length,
        type,
        accountId,
        metadata
      });
      return { filePath: `/api/file/${filename}`, fileName: FileService.getOriginFilename(filename) };
    }
  }

  static getOriginFilename(name: string) {
    const match = name.match(/-[^-]+(\.[^.]+)$/);
    return match ? match[0].substring(1) : name;
  }

  static async deleteFile(api_attachment_path: string) {
    const config = await getGlobalConfig({ useAdmin: true });
    if (api_attachment_path.includes('/api/s3file/')) {
      const { s3ClientInstance } = await this.getS3Client();
      const fileName = this.extractAndValidatePath(api_attachment_path);
      const command = new DeleteObjectCommand({
        Bucket: config.s3Bucket,
        Key: fileName,
      });
      await s3ClientInstance.send(command);
      const attachmentPath = await prisma.attachments.findFirst({ where: { path: api_attachment_path } })
      if (attachmentPath) {
        await prisma.attachments.delete({ where: { id: attachmentPath.id } })
      }
    } else {
      const filepath = this.extractAndValidatePath(api_attachment_path);
      const attachmentPath = await prisma.attachments.findFirst({ where: { path: api_attachment_path } })
      if (attachmentPath) {
        await prisma.attachments.delete({ where: { id: attachmentPath.id } })
      }
      await unlink(filepath);
    }
  }


  /**
   * Get file buffer from S3 or local storage without creating temporary files
   */
  static async getFileBuffer(filePath: string): Promise<Buffer> {
    const config = await getGlobalConfig({ useAdmin: true });

    if (config.objectStorage === 's3') {
      const { s3ClientInstance } = await this.getS3Client();
      const fileName = this.extractAndValidatePath(filePath);
      const command = new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: fileName,
      });

      const response = await s3ClientInstance.send(command);
      const chunks: any[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } else {
      const localPath = this.extractAndValidatePath(filePath);
      return await fs.readFile(localPath);
    }
  }

  /**
   * Get temporary file path (creates local copy for S3 files)
   * WARNING: This method creates temporary files for S3 storage. Use getFileBuffer() when possible.
   * Remember to clean up the returned path for S3 files after use.
   */
  static async getFile(filePath: string): Promise<{ path: string; isTemporary: boolean; cleanup?: () => Promise<void> }> {
    const config = await getGlobalConfig({ useAdmin: true });

    if (config.objectStorage === 's3') {
      const fileName = this.extractAndValidatePath(filePath);
      const tempFileName = `${Date.now()}_${path.basename(fileName)}`;
      const tempPath = this.validateAndResolvePath(`temp/${tempFileName}`, UPLOAD_FILE_PATH, true);
      await fs.mkdir(path.dirname(tempPath), { recursive: true });

      const buffer = await this.getFileBuffer(filePath);
      await fs.writeFile(tempPath, new Uint8Array(buffer));

      return {
        path: tempPath,
        isTemporary: true,
        cleanup: async () => {
          try {
            await fs.unlink(tempPath);
            // Try to remove temp directory if empty
            try {
              await fs.rmdir(path.dirname(tempPath));
            } catch {
              // Ignore if directory is not empty
            }
          } catch (error) {
            console.warn('Failed to cleanup temporary file:', tempPath, error);
          }
        }
      };
    } else {
      return {
        path: this.extractAndValidatePath(filePath),
        isTemporary: false
      };
    }
  }

  static async uploadFileStream(
    {
      stream, originalName, fileSize, type, accountId, metadata
    }: {
      stream: ReadableStream, originalName: string, fileSize: number, type: string, accountId: number, metadata?: any
    }) {
    const config = await getGlobalConfig({ useAdmin: true });
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const timestamp = Date.now();
    const timestampedFileName = `${baseName}_${timestamp}${extension}`;

    try {
      if (config.objectStorage === 's3') {
        const { s3ClientInstance } = await this.getS3Client();

        let customPath = config.s3CustomPath || '';
        if (customPath) {
          customPath = customPath.startsWith('/') ? customPath : '/' + customPath;
          customPath = customPath.endsWith('/') ? customPath : customPath + '/';
        }

        const s3Key = `${customPath}${timestampedFileName}`.replace(/^\//, '');

        const passThrough = new PassThrough();
        const nodeReadable = Readable.fromWeb(stream as any);
        
        // Setup proper error handling
        nodeReadable.on('error', (err) => {
          passThrough.destroy(err);
        });

        nodeReadable.pipe(passThrough);

        const upload = new Upload({
          client: s3ClientInstance as any,
          params: {
            Bucket: config.s3Bucket,
            Key: s3Key,
            Body: passThrough,
          },
        });

        try {
          await upload.done();
        } catch (error) {
          // Ensure streams are destroyed on error
          passThrough.destroy();
          nodeReadable.destroy();
          throw error;
        }
        
        // Explicitly destroy streams after upload completes
        passThrough.destroy();
        nodeReadable.destroy();
        
        const s3Url = `/api/s3file/${s3Key}`;

        await FileService.createAttachment({
          path: s3Url,
          name: timestampedFileName,
          size: fileSize,
          type,
          accountId,
          metadata
        });
        return { filePath: s3Url, fileName: timestampedFileName };

      } else {
        let customPath = config.localCustomPath || '';
        if (customPath) {
          customPath = customPath.startsWith('/') ? customPath : '/' + customPath;
          customPath = customPath.endsWith('/') ? customPath : customPath + '/';
        }

        const relativePath = `${customPath}${timestampedFileName}`.replace(/^\//, '');
        const fullPath = this.validateAndResolvePath(relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const writeStream = createWriteStream(fullPath);
        const nodeReadable = Readable.fromWeb(stream as any);

        // Setup proper error handling
        nodeReadable.on('error', (err) => {
          writeStream.destroy(err);
        });
        
        writeStream.on('error', (err) => {
          nodeReadable.destroy();
          throw err;
        });

        await new Promise((resolve, reject) => {
          nodeReadable.pipe(writeStream)
            .on('finish', () => {
              // Ensure writeStream is properly closed
              writeStream.end();
              resolve(null);
            })
            .on('error', (err) => {
              // Clean up both streams on error
              writeStream.destroy();
              nodeReadable.destroy();
              reject(err);
            });
        });
        await FileService.createAttachment({
          path: `/api/file/${relativePath}`,
          name: timestampedFileName,
          size: fileSize,
          type,
          noteId: null,
          accountId,
          metadata
        });
        return {
          filePath: `/api/file/${relativePath}`,
          fileName: timestampedFileName
        };
      }
    } catch (error) {
      console.error('Failed to upload file stream:', error);
      throw error;
    }
  }

  // path: /api/file/123/456/789.jpg
  static async createAttachment({
    path, name, size, type, noteId, accountId, metadata
  }: {
    path: string, name: string, size: number, type: string, noteId?: number | null, accountId: number, metadata?: any
  }) {
    const pathParts = (path as string)
      .replace('/api/file/', '')
      .replace('/api/s3file/', '')
      .split('/');

    const prefixPath = pathParts.slice(0, -1).join(',');

    await prisma.attachments.create({
      data: {
        path,
        name,
        size,
        type,
        depth: pathParts.length - 1,
        perfixPath: prefixPath.startsWith(',') ? prefixPath.substring(1) : prefixPath,
        ...(noteId ? { noteId } : {}),
        accountId,
        ...(metadata ? { metadata } : {})
      }
    })
  }

  static async renameFile(oldPath: string, newName: string) {
    const config = await getGlobalConfig({ useAdmin: true });

    await prisma.$transaction(async (prisma) => {
      if (oldPath.includes('/api/s3file/')) {
        const { s3ClientInstance } = await this.getS3Client();
        const oldKey = oldPath.replace('/api/s3file/', '');
        const dirPath = path.dirname(oldKey);

        const normalizedDirPath = dirPath === '.' ? '' : dirPath.replace(/\\/g, '/');
        const normalizedNewName = newName.replace(/\\/g, '/');
        const newKey = normalizedDirPath ? `${normalizedDirPath}/${normalizedNewName}` : normalizedNewName;

        try {
          await s3ClientInstance.send(new CopyObjectCommand({
            Bucket: config.s3Bucket,
            CopySource: encodeURIComponent(`${config.s3Bucket}/${decodeURIComponent(oldKey)}`),
            Key: decodeURIComponent(newKey)
          }));

          await s3ClientInstance.send(new DeleteObjectCommand({
            Bucket: config.s3Bucket,
            Key: decodeURIComponent(oldKey)
          }));
        } catch (error) {
          console.error('S3 rename operation failed:', error);
          throw new Error(`Failed to rename file in S3: ${error.message}`);
        }
      } else {
        const oldFilePath = this.extractAndValidatePath(oldPath);
        const sanitizedNewName = sanitizeFilename(newName, { replacement: '_' });
        if (sanitizedNewName !== newName) {
          throw new Error('Invalid new filename: contains dangerous characters');
        }
        const newFilePath = path.join(path.dirname(oldFilePath), sanitizedNewName);
        
        // Validate the new path is still within allowed directory
        const resolvedBaseDir = path.resolve(UPLOAD_FILE_PATH);
        const resolvedNewPath = path.resolve(newFilePath);
        if (!pathIsInside(resolvedNewPath, resolvedBaseDir)) {
          throw new Error('Invalid new path: outside allowed directory');
        }

        await fs.rename(oldFilePath, newFilePath);
      }
    });
  }

  static async moveFile(oldPath: string, newPath: string) {
    const config = await getGlobalConfig({ useAdmin: true });

    if (oldPath.includes('/api/s3file/')) {
      const { s3ClientInstance } = await this.getS3Client();
      const oldKey = oldPath.replace('/api/s3file/', '');
      let newKey = newPath.replace('/api/s3file/', '');

      if (newKey.startsWith('/')) {
        newKey = newKey.substring(1);
      }

      try {
        await s3ClientInstance.send(new GetObjectCommand({
          Bucket: config.s3Bucket,
          Key: decodeURIComponent(oldKey)
        }));
      } catch (error) {
        console.error('Source file check failed:', error);
        throw new Error(`Source file does not exist: ${decodeURIComponent(oldKey)}`);
      }

      try {
        await s3ClientInstance.send(new CopyObjectCommand({
          Bucket: config.s3Bucket,
          CopySource: encodeURIComponent(`${config.s3Bucket}/${decodeURIComponent(oldKey)}`),
          Key: decodeURIComponent(newKey)
        }));

        await s3ClientInstance.send(new DeleteObjectCommand({
          Bucket: config.s3Bucket,
          Key: decodeURIComponent(oldKey)
        }));
      } catch (error) {
        console.error('S3 operation failed:', error);
        throw new Error(`Failed to move file in S3: ${error.message}`);
      }
    } else {
      const oldFilePath = this.extractAndValidatePath(oldPath);
      const newFilePath = this.extractAndValidatePath(newPath);

      await fs.mkdir(path.dirname(newFilePath), { recursive: true });
      await fs.rename(oldFilePath, newFilePath);

      try {
        const oldDir = path.dirname(oldFilePath);
        const files = await fs.readdir(oldDir);

        if (files.length === 0) {
          await fs.rmdir(oldDir);

          let parentDir = path.dirname(oldDir);
          const uploadPath = path.join(UPLOAD_FILE_PATH);
          while (parentDir !== uploadPath) {
            const parentFiles = await fs.readdir(parentDir);
            if (parentFiles.length === 0) {
              await fs.rmdir(parentDir);
              parentDir = path.dirname(parentDir);
            } else {
              break;
            }
          }
        }
      } catch (error) {
        console.error('Failed to cleanup old directories:', error);
      }
    }
  }
}

