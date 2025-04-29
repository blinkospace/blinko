import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

// 确保dist目录存在
const distDir = path.resolve(process.cwd(), '../dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

async function build() {
  try {
    const result = await esbuild.build({
      entryPoints: ['index.ts'],
      bundle: true,
      minify: true,
      platform: 'node',
      target: 'node18',
      outfile: '../dist/index.js',
      format: 'cjs',
      sourcemap: true,
      metafile: true,
      banner: {
        js: '#!/usr/bin/env bun\n',
      },
      packages: 'bundle',
      external: [
        'buffer', 'crypto', 'events', 'fs', 'http', 'https', 'net', 
        'os', 'path', 'querystring', 'stream', 'string_decoder', 
        'url', 'util', 'zlib',
        '@node-rs/crc32',
        'lightningcss',
        'llamaindex',
        'onnxruntime-node',
        'onnxruntime-web',
        '@libsql/core',
        '@libsql/client',
        '@langchain/community',
        'sharp',
        'sqlite3'
      ],
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      loader: {
        '.ts': 'ts',
        '.js': 'js',
        '.mjs': 'js',
        '.cjs': 'js',
        '.json': 'json',
      },
      conditions: ['node', 'require'],
      mainFields: ['main'],
    });

    console.log('构建成功!');
    console.log(`输出文件: ${path.resolve(process.cwd(), '../dist/index.js')}`);
    
    if (result.metafile) {
      const outputFile = Object.keys(result.metafile.outputs)[0];
      const fileSizeMB = result.metafile.outputs[outputFile].bytes / 1024 / 1024;
      console.log(`JS 大小: ${fileSizeMB.toFixed(2)}MB`);
      
      // 输出已包含的最大模块
      const sortedInputs = Object.entries(result.metafile.inputs)
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 10);
      
      console.log('\n最大的10个包含模块:');
      for (const [name, info] of sortedInputs) {
        console.log(`- ${name}: ${(info.bytes / 1024).toFixed(2)}KB`);
      }
    }
  } catch (error) {
    console.error('构建失败:', error);
    process.exit(1);
  }
}

build(); 