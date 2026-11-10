import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { t } from '../../middleware';
import { ServiceError, toPublicError } from './errors';

export type ServicePath = 'capabilities'|'vector.status'|'vector.query'|'vector.snapshots.create'|'vector.snapshots.sample'|'vector.snapshots.readNote'|'vector.snapshots.release'|'ai.listModels'|'ai.generateText'|'admin.getPolicy'|'admin.setPolicy';
export function hasServicePermission(permissions: unknown, path: string): boolean {
  if (permissions === undefined) return true;
  if (!Array.isArray(permissions)) return false;
  const namespace = path.startsWith('pluginServices.vector.') ? 'pluginServices.vector'
    : path.startsWith('pluginServices.ai.') ? 'pluginServices.ai' : null;
  return permissions.some(permission => typeof permission === 'string' &&
    (permission === path || permission === 'pluginServices' || permission === namespace));
}

/** Authorization travels with every procedure, including accidental secondary mounts. */
export function serviceProcedure(operation: ServicePath) {
  const expected = `pluginServices.${operation}`;
  return t.procedure.use(async ({ctx,path,next}) => {
    if (path !== expected) throw new TRPCError({code:'FORBIDDEN',message:'Service path is not permitted.'});
    const accountId=Number(ctx.id ?? ctx.sub);
    if (!ctx.name || ctx.requiresTwoFactor || !Number.isSafeInteger(accountId) || accountId<=0)
      throw new TRPCError({code:'UNAUTHORIZED',message:'Authentication required.'});
    if (!hasServicePermission(ctx.permissions,path)) throw new TRPCError({code:'FORBIDDEN',message:'Service permission required.'});
    if (operation.startsWith('admin.') && ctx.role!=='superadmin') throw new TRPCError({code:'FORBIDDEN',message:'Administrator required.'});
    const result=await next({ctx:{...ctx,id:String(accountId)}});
    if (!result.ok) {
      const cause=result.error.cause;
      const invalidInput = result.error.code === 'BAD_REQUEST' && (!cause || cause instanceof ZodError);
      const error=toPublicError(invalidInput ? new ServiceError('INVALID_INPUT') : cause);
      throw new TRPCError({code:'BAD_REQUEST', message:JSON.stringify(error)});
    }
    return result;
  });
}
