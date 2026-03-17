import axios from "axios";
import { authenticator } from 'otplib';
import crypto from 'crypto';
import { Feed } from "feed";
import jwt from 'jsonwebtoken';
import { prisma } from "@server/prisma";
import { User } from "@server/context";
import { Request as ExpressRequest } from 'express';
import { getGlobalConfig } from "@server/routerTrpc/config";

export const SendWebhook = async (data: any, webhookType: string, ctx: any) => {
  try {
    const globalConfig = await getGlobalConfig({ ctx })
    if (globalConfig.webhookEndpoint) {
      await axios.post(globalConfig.webhookEndpoint, { data, webhookType, activityType: `blinko.note.${webhookType}` })
    }
  } catch (error) {
    console.log('request webhook error:', error)
  }
}

export function generateTOTP(): string {
  return authenticator.generateSecret();
}

export function generateTOTPQRCode(username: string, secret: string): string {
  return authenticator.keyuri(username, 'Blinko', secret);
}

export function verifyTOTP(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch (err) {
    return false;
  }
}


export async function generateFeed(userId: number, origin: string, rows: number = 20) {
  const hasAccountId: any = {}
  if (userId != 0) {
    hasAccountId.accountId = userId
  }
  const notes = await prisma.notes.findMany({
    where: {
      ...hasAccountId,
      isShare: true,
      sharePassword: "",
      OR: [
        {
          shareExpiryDate: {
            gt: new Date()
          }
        },
        {
          shareExpiryDate: null
        }
      ]
    },
    orderBy: { updatedAt: 'desc' },
    take: rows,
    select: {
      content: true,
      updatedAt: true,
      shareEncryptedUrl: true,
      tags: {
        include: { tag: true }
      },
      account: {
        select: {
          name: true
        }
      },
    }
  });

  const feed = new Feed({
    title: "Blinko Public Notes",
    description: "Latest public notes",
    id: origin,
    link: origin,
    copyright: "All rights reserved",
    updated: new Date(),
    image: `${origin}/logo-dark-title.png`,
    feedLinks: {
      atom: `${origin}/api/rss/${userId}/atom`,
      rss: `${origin}/api/rss/${userId}/rss`
    },
  });

  notes.forEach(note => {
    const title = note.content.split('\n')[0] || 'Untitled';
    feed.addItem({
      title,
      link: `${origin}/share/${note.shareEncryptedUrl}`,
      description: note.content.substring(0, 200) + '...',
      date: note.updatedAt,
      author: [{
        name: note.account!.name
      }],
      category: note.tags.map(i => {
        return {
          name: i.tag.name
        }
      })
    });
  });

  return feed;
}

let isLoading = false

export const getNextAuthSecret = async () => {
  const configKey = 'JWT_SECRET';
  let secret = process.env.JWT_SECRET;
  if (isLoading) {
    return secret!
  }
  if (!secret || secret === 'my_ultra_secure_nextauth_secret') {
    const savedSecret = await prisma.config.findFirst({
      where: { key: configKey }
    });
    if (savedSecret) {
      // @ts-ignore
      secret = savedSecret.config.value as string;
    } else {
      const newSecret = crypto.randomBytes(32).toString('base64');
      await prisma.config.create({
        data: {
          key: configKey,
          config: { value: newSecret }
        }
      });
      secret = newSecret;
    }
  }
  isLoading = false
  return secret;
}

export const generateApiToken = async (user: { id: number, name: string, role: string }, permissions?: string[]) => {
  const secret = await getNextAuthSecret();
  return jwt.sign(
    {
      role: user.role,
      name: user.name,
      sub: user.id.toString(),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 365 * 100),
      iat: Math.floor(Date.now() / 1000),
      permissions
    },
    secret
  );
};

export const generateToken = async (user: any, twoFactorVerified = false) => {
  const secret = await getNextAuthSecret();
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      role: user.role || 'user',
      twoFactorVerified,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30),
      iat: Math.floor(Date.now() / 1000)
    },
    secret,
    { algorithm: 'HS256' }
  );
};

export const verifyToken = async (token: string) => {
  const secret = await getNextAuthSecret();
  try {
    const decoded = jwt.verify(token, secret) as User;
    return decoded;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
};

export const getTokenFromRequest = async (req: ExpressRequest) => {
  try {
    if (req.headers && typeof req.headers === 'object') {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace("Bearer ", "");
        const tokenData = await verifyToken(token);
        if (tokenData) return { ...tokenData, id: tokenData.sub, token };
      }
    }

    if (req.query && req.query.token) {
      const token = req.query.token as string;
      const tokenData = await verifyToken(token);
      if (tokenData) return { ...tokenData, id: tokenData.sub, token };
    }

    return null;
  } catch (error) {
    console.error('Token retrieval error:', error);
    return null;
  }
}

export const getAllPathTags = async () => {
  const flattenTags = await prisma.tag.findMany();
  const hasHierarchy = flattenTags.some(tag => tag.parent != null);
  if (hasHierarchy) {
    const buildHashTagTreeFromDb = (tags: any[]) => {
      const tagMap = new Map();
      const rootNodes: any[] = [];
      tags.forEach(tag => {
        tagMap.set(tag.id, { ...tag, children: [] });
      });
      tags.forEach(tag => {
        if (tag.parent) {
          const parentNode = tagMap.get(tag.parent);
          if (parentNode) {
            parentNode.children.push(tagMap.get(tag.id));
          } else {
            rootNodes.push(tagMap.get(tag.id));
          }
        } else {
          rootNodes.push(tagMap.get(tag.id));
        }
      });

      return rootNodes;
    };

    const generateTagPaths = (node: any, parentPath = '') => {
      const currentPath = parentPath ? `${parentPath}/${node.name}` : `#${node.name}`;
      const paths = [currentPath];

      if (node.children && node.children.length > 0) {
        node.children.forEach((child: any) => {
          const childPaths = generateTagPaths(child, currentPath);
          paths.push(...childPaths);
        });
      }

      return paths;
    };

    const listTags = buildHashTagTreeFromDb(flattenTags);
    let pathTags: string[] = [];

    listTags.forEach(node => {
      pathTags = pathTags.concat(generateTagPaths(node));
    });

    return pathTags;
  } else {
    const tagPathMap = new Map();
    const tagSet = new Set<string>();
    flattenTags.forEach(tag => {
      const tagName = tag.name.startsWith('#') ? tag.name.substring(1) : tag.name;
      tagSet.add(tagName);
      tagPathMap.set(tagName, `#${tagName}`);
    });
    const pathTags: string[] = [];
    tagSet.forEach((tag: string) => {
      pathTags.push(`#${tag}`);
      if (tag.includes('/')) {
        const parts = tag.split('/');
        let currentPath = '#' + parts[0];
        pathTags.push(currentPath);

        for (let i = 1; i < parts.length; i++) {
          currentPath += '/' + parts[i];
          pathTags.push(currentPath);
        }
      }
    });
    return [...new Set(pathTags)];
  }
};


export const resetSequences = async () => {
  await prisma.$executeRaw`SELECT setval('notes_id_seq', (SELECT MAX(id) FROM "notes") + 1);`;
  await prisma.$executeRaw`SELECT setval('tag_id_seq', (SELECT MAX(id) FROM "tag") + 1);`;
  await prisma.$executeRaw`SELECT setval('"tagsToNote_id_seq"', (SELECT MAX(id) FROM "tagsToNote") + 1);`;
  await prisma.$executeRaw`SELECT setval('attachments_id_seq', (SELECT MAX(id) FROM "attachments") + 1);`;
}

export const getUserFromSession = (req: any) => {
  if (req && req.isAuthenticated && req.isAuthenticated() && req.user) {
    const user = req.user;
    return {
      id: user.id.toString(),
      sub: user.id.toString(),
      name: user.name,
      role: user.role || 'user',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 * 1000,
      iat: Math.floor(Date.now() / 1000),
    };
  }
  return null;
};

export const getUserFromRequest = async (req: any) => {
  const sessionUser = getUserFromSession(req);
  if (sessionUser) {
    return sessionUser;
  }

  return await getTokenFromRequest(req);
};

// 生成带token的URL
export const generateUrlWithToken = async (url: string, user: any) => {
  const token = await generateToken(user);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${token}`;
}

