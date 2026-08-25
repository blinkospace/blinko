import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

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
        'os', 'path', 'querystring', 'stream', 'util', 'zlib',
        '@node-rs/crc32',
        'lightningcss',
        'llamaindex',
        'onnxruntime-node',
        'onnxruntime-web',
        '@langchain/community',
        'sharp',
        'esbuild',
        'sqlite3',
        'fsevents',
        '@libsql/linux-x64-musl',
        '@libsql/linux-x64-gnu',
        '@libsql/linux-arm64-musl',
        '@libsql/linux-arm64-gnu'
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

    console.log('Build successful!');
    console.log(`Output file: ${path.resolve(process.cwd(), '../dist/index.js')}`);
    
    if (result.metafile) {
      const outputFile = Object.keys(result.metafile.outputs)[0];
      const fileSizeMB = result.metafile.outputs[outputFile].bytes / 1024 / 1024;
      console.log(`JS size: ${fileSizeMB.toFixed(2)}MB`);
      
      const sortedInputs = Object.entries(result.metafile.inputs)
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 10);
      
      console.log('\nThe largest 10 modules:');
      for (const [name, info] of sortedInputs) {
        console.log(`- ${name}: ${(info.bytes / 1024).toFixed(2)}KB`);
      }
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
