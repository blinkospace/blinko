import { PrismaClient } from '@prisma/client';

import { promises as fs } from 'fs';
import { randomBytes, pbkdf2 } from 'crypto';

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