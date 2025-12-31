import { PrismaClient } from '@prisma/client';

import { promises as fs } from 'fs';
import { randomBytes, pbkdf2 } from 'crypto';
import * as path from 'path';
import { FontSeed, systemDefaultFont, cdnFonts } from './defaultFonts';

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    pbkdf2(password, salt, 1000, 64, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      resolve('pbkdf2:' + salt + ':' + derivedKey.toString('hex'));
    });
  });
}

export async function verifyPassword(inputPassword: string, hashedPassword: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [prefix, salt, hash] = hashedPassword.split(':');
    if (prefix !== 'pbkdf2') {
      return resolve(false);
    }
    pbkdf2(inputPassword, salt!, 1000, 64, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString('hex') === hash);
    });
  });
}

const prisma = new PrismaClient();

async function main() {
  try {
    await fs.mkdir(".blinko")
  } catch (error) { }

  try {
    await Promise.all([fs.mkdir(".blinko/files"), fs.mkdir(".blinko/vector"), fs.mkdir(".blinko/pgdump")])
  } catch (error) { }

  //Compatible with users prior to v0.2.9
  const account = await prisma.accounts.findFirst({ orderBy: { id: 'asc' } })
  if (account) {
    if (!account.role) {
      await prisma.accounts.update({ where: { id: account.id }, data: { role: 'superadmin' } })
    }
    await prisma.notes.updateMany({ where: { accountId: null }, data: { accountId: account.id } })
  }
  // if (!account && process.env.NODE_ENV === 'development') {
  //   await prisma.accounts.create({ data: { name: 'admin', password: await hashPassword('123456'), role: 'superadmin' } })
  // }

  //database password hash
  const accounts = await prisma.accounts.findMany()
  for (const account of accounts) {
    const isHash = account.password.startsWith('pbkdf2:')
    if (!isHash) {
      await prisma.accounts.update({ where: { id: account.id }, data: { password: await hashPassword(account.password) } })
    }
  }

  const tagsWithoutAccount = await prisma.tag.findMany({ where: { accountId: null } })
  for (const account of accounts) {
    if (account.role == 'superadmin') {
      await prisma.tag.updateMany({ where: { id: { in: tagsWithoutAccount.map(tag => tag.id) } }, data: { accountId: account.id } })
      break
    }
  }
  try {
    // update attachments depth and perfixPath
    const attachmentsWithoutDepth = await prisma.attachments.findMany({
      where: {
        OR: [
          { depth: null },
          { perfixPath: null }
        ]
      }
    });

    if (attachmentsWithoutDepth.length > 0) {
      for (const attachment of attachmentsWithoutDepth) {
        const pathParts = attachment.path
          .replace('/api/file/', '')
          .replace('/api/s3file/', '')
          .split('/');

        await prisma.attachments.update({
          where: { id: attachment.id },
          data: {
            depth: pathParts.length - 1,
            perfixPath: pathParts.slice(0, -1).join(',')
          }
        });
      }
    }
  } catch (error) {
    console.log(error)
  }
  await seedDefaultFonts();
}

export async function seedDefaultFonts() {
  const fontsDir = path.resolve(__dirname, "../app/public/fonts");

  const localFonts = await scanLocalFonts(fontsDir);

  const allFonts: FontSeed[] = [systemDefaultFont, ...cdnFonts, ...localFonts];

  console.log("🔤 Seeding fonts...");
  console.log(`   🌐 CDN fonts: ${cdnFonts.length}`);
  console.log(`   📁 Local fonts: ${localFonts.length}`);

  for (const font of allFonts) {
    const fontData = {
      ...font,
      fileData: font.fileData ? Buffer.from(font.fileData) : null,
    };
    await prisma.fonts.upsert({
      where: { name: font.name },
      update: fontData,
      create: fontData,
    });
  }
}
/**
 * Scan the fonts directory and discover all local font families
 * Expects structure: fonts/{FontName}/{FontName}-*.woff2
 */
async function scanLocalFonts(fontsDir: string): Promise<FontSeed[]> {
  try {
    await fs.access(fontsDir);
  } catch {
    console.log(`ℹ Fonts directory not found: ${fontsDir}`);
    return [];
  }

  const entries = await fs.readdir(fontsDir, { withFileTypes: true });

  const tasks = entries
    .filter(e => e.isDirectory())
    .map((entry, index) => processFontFamily(fontsDir, entry.name, index + 1));

  return (await Promise.all(tasks)).filter(
    (f): f is FontSeed => f !== null
  );
}



async function processFontFamily(
  fontsDir: string,
  fontName: string,
  sortOrder: number
): Promise<FontSeed | null> {
  try {
    const fontDir = path.join(fontsDir, fontName);
    const files = await fs.readdir(fontDir);

    const fontFiles = files.filter(f => f.endsWith(".woff") || f.endsWith(".woff2"));
    if (!fontFiles.length) return null;

    const mainFontFile = pickMainFont(fontFiles);
    if (!mainFontFile) return null;

    const filePath = path.join(fontDir, mainFontFile);
    const buffer = await fs.readFile(filePath);

    return {
      name: fontName,
      displayName: `${fontName} (Ext)`,
      url: null,
      fileData: new Uint8Array(buffer),
      isLocal: true,
      weights: isVariableFont(mainFontFile)
        ? [100, 200, 300, 400, 500, 600, 700, 800, 900]
        : [400, 500, 600, 700],
      category: detectFontCategory(fontName),
      isSystem: false,
      sortOrder,
    };
  } catch (err) {
    console.warn(`⚠ Failed to load font: ${fontName}`);
    return null;
  }
}
function pickMainFont(files: string[]): string | null {
  return (
    files.find(f => /variablefont/i.test(f) && !/italic/i.test(f) && f.endsWith(".woff2")) ||
    files.find(f => !/italic/i.test(f) && f.endsWith(".woff2")) ||
    files.find(f => f.endsWith(".woff2")) ||
    files[0] ||
    null
  );
}

function isVariableFont(fileName: string): boolean {
  return /variablefont/i.test(fileName);
}

/**
 * Detect font category based on font name
 */
function detectFontCategory(fontName: string): string {
  const name = fontName.toLowerCase();

  if (
    name.includes("mono") ||
    name.includes("code") ||
    name.includes("consola") ||
    name.includes("courier") ||
    name.includes("fira") ||
    name.includes("jetbrains")
  ) return "monospace";

  if (
    name.includes("serif") ||
    name.includes("times") ||
    name.includes("georgia") ||
    name.includes("merriweather") ||
    name.includes("playfair") ||
    name.includes("baskerville")
  ) return "serif";

  if (
    name.includes("display") ||
    name.includes("black") ||
    name.includes("ultra")
  ) return "display";

  if (
    name.includes("script") ||
    name.includes("cursive") ||
    name.includes("hand") ||
    name.includes("pacifico") ||
    name.includes("dancing")
  ) return "handwriting";

  return "sans-serif";
}

main()
  .then(e => {
    console.log("✨ Seed done! ✨")
  })
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });