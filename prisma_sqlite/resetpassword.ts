import { PrismaClient } from '@prisma/client'

import { randomBytes, pbkdf2 } from 'crypto'

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    pbkdf2(password, salt, 1000, 64, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      resolve('pbkdf2:' + salt + ':' + derivedKey.toString('hex'));
    });
  });
}

const prisma = new PrismaClient();

async function main() {
  try {
    const password = await hashPassword('123456')
    const accounts = await prisma.accounts.findFirst({
      where: { role: 'superadmin' }
    })
    await prisma.accounts.update({
      where: { id: accounts?.id },
      data: { password }
    })
  } catch (error) {
    console.log(error)
  }
}

main()
  .then(e => {
    console.log("✨ Reset password done! Your password is 123456 ✨")
  })
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });