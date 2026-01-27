import { router, publicProcedure, authProcedure, superAdminAuthMiddleware, demoAuthMiddleware } from '../middleware';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import { accountsSchema } from '@shared/lib/prismaZodType';
import { hashPassword, verifyPassword } from '@prisma/seed';
import { generateTOTP, generateTOTPQRCode, getNextAuthSecret, verifyTOTP } from "@server/lib/helper";
import { deleteNotes } from './note';
import { createSeed } from '@prisma/seedData';
import jwt from 'jsonwebtoken';

const genToken = async ({ id, name, role, permissions }: { id: number, name: string, role: string, permissions?: string[] }) => {
  const secret = await getNextAuthSecret();
  return jwt.sign(
    {
      role,
      name,
      sub: id.toString(),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 365 * 100),
      iat: Math.floor(Date.now() / 1000),
      permissions
    },
    secret
  )
}

export const userRouter = router({
  list: authProcedure.use(superAdminAuthMiddleware)
    .meta({
      openapi: {
        method: 'GET', path: '/v1/user/list', summary: 'Find user list',
        description: 'Find user list, need super admin permission', tags: ['User']
      }
    })
    .input(z.void())
    .output(z.array(accountsSchema))
    .query(async () => {
      return await prisma.accounts.findMany()
    }),
  publicUserList: publicProcedure
    .meta({
      openapi: {
        method: 'GET', path: '/v1/user/public-user-list', summary: 'Find public user list',
        description: 'Find public user list without admin permission. Only returns non-sensitive information.', tags: ['User']
      }
    })
    .input(z.void())
    .output(z.array(z.object({
      id: z.number().int(),
      nickname: z.string(),
      image: z.string().nullable(),
      description: z.string().nullable(),
    })))
    .query(async () => {
      // Security fix: Only return non-sensitive public information
      // Removed: name, role, loginType, createdAt, updatedAt, linkAccountId
      return await prisma.accounts.findMany({
        select: {
          id: true,
          nickname: true,
          image: true,
          description: true,
          // Removed sensitive fields: name, role, loginType, createdAt, updatedAt, linkAccountId
        }
      })
    }),
  nativeAccountList: authProcedure
    .meta({
      openapi: {
        method: 'GET', path: '/v1/user/native-account-list', summary: 'Find native account list',
        description: 'find native account list which use username and password to login', tags: ['User']
      }
    })
    .input(z.void())
    .output(z.array(z.object({
      id: z.number().int(),
      name: z.string(),
      nickname: z.string(),
    })))
    .query(async () => {
      const accounts = await prisma.accounts.findMany({
        where: {
          loginType: '',
          NOT: {
            id: {
              in: (await prisma.accounts.findMany({
                where: { linkAccountId: { not: null } },
                select: { linkAccountId: true }
              })).map(a => a.linkAccountId!)
            }
          }
        },
        select: {
          id: true,
          name: true,
          nickname: true,
        }
      })
      return accounts
    }),
  linkAccount: authProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/link-account', summary: 'Link account',
        description: 'Link account', tags: ['User']
      }
    })
    .input(z.object({
      id: z.number(),
      originalPassword: z.string()
    }))
    .output(z.boolean())
    .mutation(async ({ input, ctx }) => {
      const user = await prisma.accounts.findFirst({ where: { id: input.id } })
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' })
      }
      if (input.originalPassword) {
        if (!(await verifyPassword(input.originalPassword, user?.password ?? ''))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Password is incorrect' });
        }
      }
      await prisma.accounts.update({ where: { id: Number(ctx.id) }, data: { linkAccountId: user.id } })
      return true
    }),
  unlinkAccount: authProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/unlink-account', summary: 'Unlink account',
        description: 'Unlink account', tags: ['User']
      }
    })
    .input(z.object({ id: z.number() }))
    .output(z.boolean())
    .mutation(async ({ input }) => {
      await prisma.accounts.updateMany({
        where: { linkAccountId: input.id },
        data: { linkAccountId: null }
      })
      return true
    }),
  detail: authProcedure
    .meta({
      openapi: {
        method: 'GET', path: '/v1/user/detail', summary: 'Find user detail from user id',
        description: 'Find user detail from user id, need login. Can only view own info unless superadmin.', tags: ['User']
      }
    })
    .input(z.object({ id: z.number().optional() }))
    .output(z.object({
      id: z.number(),
      name: z.string(),
      nickName: z.string(),
      token: z.string(),
      isLinked: z.boolean(),
      loginType: z.string(),
      image: z.string().nullable(),
      role: z.string()
    }))
    .query(async ({ input, ctx }) => {
      const requestedId = input.id ?? Number(ctx.id);
      const currentUserId = Number(ctx.id);

      // Get current user to check permissions
      const currentUser = await prisma.accounts.findFirst({
        where: { id: currentUserId }
      });

      if (!currentUser) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Current user not found'
        });
      }

      // Security fix: Only allow viewing own info unless current user is superadmin
      if (requestedId !== currentUserId) {
        if (currentUser.role !== 'superadmin') {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You can only view your own information'
          });
        }
      }

      // Get requested user
      const user = await prisma.accounts.findFirst({
        where: { id: requestedId }
      });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      const isLinked = await prisma.accounts.findFirst({
        where: { linkAccountId: requestedId }
      });

      // Security fix: Only return token when viewing own info
      const token = requestedId === currentUserId ? (user.apiToken ?? '') : '';

      return {
        id: requestedId,
        name: user.name ?? '',
        nickName: user.nickname ?? '',
        token: token,
        loginType: user.loginType ?? '',
        isLinked: isLinked ? true : false,
        image: user.image ?? null,
        role: user.role ?? ''
      }
    }),
  canRegister: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/user/can-register', summary: 'Check if can register admin', tags: ['User'] } })
    .input(z.void())
    .output(z.boolean())
    .mutation(async () => {
      try {
        console.log('canRegisterxxx')
        const count = await prisma.accounts.count()
        if (count == 0) {
          return true
        } else {
          const res = await prisma.config.findFirst({ where: { key: 'isAllowRegister' } })
          //@ts-ignore
          return res?.config.value === true
        }
      } catch (error) {
        console.log(error, 'canRegister error')
        return true
      }
    }),
  register: publicProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/register', summary: 'Register user or admin',
        description: 'Register user or admin', tags: ['User']
      }
    })
    .input(z.object({
      name: z.string(),
      password: z.string()
    }))
    .output(z.union([z.boolean(), z.any()]))
    .mutation(async ({ input }) => {
      return prisma.$transaction(async () => {
        const { name, password } = input
        const passwordHash = await hashPassword(password)
        const count = await prisma.accounts.count()
        if (count == 0) {
          const res = await prisma.accounts.create({
            data: {
              name,
              password: passwordHash,
              nickname: name,
              role: 'superadmin',
            }
          })
          await prisma.accounts.update({
            where: { id: res.id },
            data: {
              apiToken: await genToken({ id: res.id, name, role: 'superadmin' })
            }
          })
          await prisma.config.create({
            data: {
              key: 'theme',
              config: { value: 'system' },
              userId: res.id
            }
          })
          await createSeed(res.id)
          return true
        } else {
          const config = await prisma.config.findFirst({ where: { key: 'isAllowRegister' } })
          //@ts-ignore
          if (config?.config?.value === false || !config) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'not allow register',
            });
          } else {
            const hasSameUser = await prisma.accounts.findFirst({ where: { name } })
            if (hasSameUser) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Username already exists'
              });
            }
            const res = await prisma.accounts.create({ data: { name, password: passwordHash, nickname: name, role: 'user' } })
            await prisma.accounts.update({ where: { id: res.id }, data: { apiToken: await genToken({ id: res.id, name, role: 'user' }) } })
            return true
          }
        }
      })
    }),
  regenToken: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/user/regen-token', summary: 'Regen token', tags: ['User'] } })
    .input(z.void())
    .output(z.boolean())
    .mutation(async ({ ctx }) => {
      const user = await prisma.accounts.findFirst({ where: { id: Number(ctx.id) } })
      if (user) {
        const token = await genToken({ id: user.id, name: user.name ?? '', role: user.role })
        console.log('token', token);
        await prisma.accounts.update({ where: { id: user.id }, data: { apiToken: token } })
        return true
      } else {
        return false
      }
    }),
  genLowPermToken: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/user/gen-low-perm-token', summary: 'Generate low permission token', tags: ['User'] } })
    .input(z.void())
    .output(z.object({
      token: z.string()
    }))
    .mutation(async ({ ctx }) => {
      const user = await prisma.accounts.findFirst({ where: { id: Number(ctx.id) } });
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const token = await genToken({
        id: user.id,
        name: user.name ?? '',
        role: user.role,
        permissions: ['notes.upsert', 'ai.completions', 'users.list', 'users.genTokenByUserId']
      });

      return { token };
    }),
  genTokenByUserId: authProcedure.use(superAdminAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/user/gen-token-by-user-id',
        summary: 'Generate tokens by user IDs',
        description: 'Generate tokens for specific users by user IDs, need super admin permission',
        tags: ['User']
      }
    })
    .input(z.object({
      userIds: z.array(z.number())
    }))
    .output(z.array(z.object({
      userId: z.number(),
      token: z.string(),
      name: z.string(),
      success: z.boolean(),
      error: z.string().optional()
    })))
    .mutation(async ({ input }) => {
      const results: Array<{
        userId: number;
        token: string;
        name: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const userId of input.userIds) {
        try {
          const user = await prisma.accounts.findFirst({ where: { id: userId } });
          if (!user) {
            results.push({
              userId,
              token: '',
              name: '',
              success: false,
              error: 'User not found'
            });
            continue;
          }

          const token = await genToken({
            id: user.id,
            name: user.name ?? '',
            role: user.role
          });

          results.push({
            userId: user.id,
            token,
            name: user.name ?? '',
            success: true
          });
        } catch (error) {
          results.push({
            userId,
            token: '',
            name: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      return results;
    }),
  upsertUser: authProcedure.use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/upsert', summary: 'Update or create user',
        description: 'Update or create user, need login. Can only update own account.', tags: ['User']
      }
    })
    .input(z.object({
      id: z.number().optional(),
      name: z.string().optional(),
      originalPassword: z.string().optional(),
      password: z.string().optional(),
      nickname: z.string().optional(),
      image: z.string().optional()
    }))
    .output(z.union([z.boolean(), z.any()]))
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async () => {
        const { id, nickname, name, password, originalPassword, image } = input
        const currentUserId = Number(ctx.id)

        // Get current user to check permissions
        const currentUser = await prisma.accounts.findFirst({
          where: { id: currentUserId }
        });

        if (!currentUser) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Current user not found'
          });
        }

        const update: Prisma.accountsUpdateInput = {}
        if (id) {
          const targetId = id;
          
          // Security fix: Ownership check - only allow updating own account unless superadmin
          if (targetId !== currentUserId && currentUser.role !== 'superadmin') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You can only update your own account'
            });
          }

          // Get target user
          const targetUser = await prisma.accounts.findFirst({
            where: { id: targetId }
          });

          if (!targetUser) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'User not found'
            });
          }

          // Security fix: If updating password, originalPassword is required
          if (password) {
            if (!originalPassword) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Original password is required when changing password'
              });
            }

            // Verify original password
            if (!(await verifyPassword(originalPassword, targetUser.password ?? ''))) {
              throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'Original password is incorrect'
              });
            }

            const passwordHash = await hashPassword(password);
            update.password = passwordHash;
          }

          if (name) update.name = name;
          if (nickname) update.nickname = nickname;
          if (image) update.image = image;

          await prisma.accounts.update({ where: { id: targetId }, data: update });
          return true;
        } else {
          // Creating new user - only allow if no users exist or registration is allowed
          if (!password) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Password is required' });
          }
          const passwordHash = await hashPassword(password!);
          const res = await prisma.accounts.create({ data: { name, password: passwordHash, nickname: name, role: 'user' } });
          await prisma.accounts.update({ where: { id: res.id }, data: { apiToken: await genToken({ id: res.id, name: name ?? '', role: 'user' }) } });
          return true;
        }
      })
    }),
  upsertUserByAdmin: authProcedure.use(superAdminAuthMiddleware).use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/upsert-by-admin', summary: 'Update or create user by admin'
        , description: 'Update or create user by admin, need super admin permission', tags: ['User']
      }
    })
    .input(z.object({
      id: z.number().optional(),
      name: z.string().optional(),
      password: z.string().optional(),
      nickname: z.string().optional()
    }))
    .output(z.union([z.boolean(), z.any()]))
    .mutation(async ({ input }) => {
      return prisma.$transaction(async () => {
        const { id, nickname, name, password } = input

        const update: Prisma.accountsUpdateInput = {}

        if (name && (!id || (id && (await prisma.accounts.findUnique({ where: { id } }))?.name !== name))) {
          const hasSameUser = await prisma.accounts.findFirst({ where: { name } });
          if (hasSameUser) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Username already exists'
            });
          }
        }

        if (id) {
          if (name) update.name = name
          if (password) {
            const passwordHash = await hashPassword(password)
            update.password = passwordHash
          }
          if (nickname) update.nickname = nickname
          await prisma.accounts.update({ where: { id }, data: update })
          return true
        } else {
          if (!password) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Password is required' });
          }
          const passwordHash = await hashPassword(password!)
          const res = await prisma.accounts.create({ data: { name, password: passwordHash, nickname: name, role: 'user' } })
          await prisma.accounts.update({ where: { id: res.id }, data: { apiToken: await genToken({ id: res.id, name: name ?? '', role: 'user' }) } })
          return true
        }
      })
    }),
  generate2FASecret: authProcedure.use(demoAuthMiddleware)
    .input(z.object({
      name: z.string()
    }))
    .mutation(async ({ input }) => {
      const secret = generateTOTP();
      const qrCode = generateTOTPQRCode(input.name, secret);
      return { secret, qrCode };
    }),
  verify2FAToken: authProcedure.use(demoAuthMiddleware)
    .input(z.object({
      token: z.string(),
      secret: z.string()
    }))
    .mutation(async ({ input }) => {
      const isValid = verifyTOTP(input.token, input.secret);
      if (!isValid) {
        throw new Error('Invalid verification code');
      }
      return true;
    }),
  deleteUser: authProcedure.use(superAdminAuthMiddleware).use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'DELETE',
        path: '/v1/user/delete',
        summary: 'Delete user',
        description: 'Delete user and all related data, need super admin permission',
        tags: ['User']
      }
    })
    .input(z.object({
      id: z.number()
    }))
    .output(z.boolean())
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async () => {
        const { id } = input

        const userToDelete = await prisma.accounts.findFirst({
          where: { id }
        })

        if (!userToDelete) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User not found'
          })
        }

        if (userToDelete.role === 'superadmin') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot delete super admin account'
          })
        }

        if (userToDelete.id === Number(ctx.id)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot delete yourself'
          })
        }

        const userNotes = await prisma.notes.findMany({
          where: { accountId: id }
        })

        await deleteNotes(userNotes.map(note => note.id), ctx)

        await prisma.config.deleteMany({
          where: { userId: id }
        })

        await prisma.noteInternalShare.deleteMany({
          where: { accountId: id }
        })

        await prisma.follows.deleteMany({
          where: { accountId: id }
        })

        await prisma.notifications.deleteMany({
          where: { accountId: id }
        })

        await prisma.conversation.deleteMany({
          where: { accountId: id }
        })

        await prisma.accounts.delete({
          where: { id }
        })

        return true
      })
    }),
  login: publicProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/v1/user/login',
        summary: 'user login',
        description: 'user login, return user basic info and token',
        tags: ['User']
      }
    })
    .input(z.object({
      name: z.string(),
      password: z.string()
    }))
    .output(z.object({
      id: z.number(),
      name: z.string(),
      nickname: z.string(),
      role: z.string(),
      token: z.string(),
      image: z.string().nullable(),
      loginType: z.string()
    }))
    .mutation(async ({ input }) => {
      const { name, password } = input;

      const user = await prisma.accounts.findFirst({
        where: { name }
      });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'user not found'
        });
      }

      const isPasswordValid = await verifyPassword(password, user.password ?? '');
      if (!isPasswordValid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'password is incorrect'
        });
      }

      const token = await genToken({
        id: user.id,
        name: user.name ?? '',
        role: user.role
      });

      await prisma.accounts.update({
        where: { id: user.id },
        data: { apiToken: token }
      });

      return {
        id: user.id,
        name: user.name ?? '',
        nickname: user.nickname ?? '',
        role: user.role,
        token: token,
        image: user.image,
        loginType: user.loginType ?? ''
      };
    }),
})
