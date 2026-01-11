import { router, authProcedure, publicProcedure } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';
import { GlobalConfig, ZConfigKey, ZConfigSchema, ZUserPerferConfigKey } from '../../shared/lib/types';
import { configSchema } from '@shared/lib/prismaZodType';
import { Context } from '../context';
import { reinitializeOAuthStrategies } from '../routerExpress/auth/config';

export const getGlobalConfig = async ({ ctx, useAdmin = false }: { ctx?: Context, useAdmin?: boolean }) => {
  const userId = Number(ctx?.id ?? 0);
  const configs = await prisma.config.findMany();
  const isSuperAdmin = useAdmin ? true : ctx?.role === 'superadmin';

  const globalConfig = configs.reduce((acc, item) => {
    const config = item.config as { type: string, value: any };
    //If not login return the frist config
    if (
      item.key == 'isCloseBackgroundAnimation'
      || item.key == 'isAllowRegister'
      || item.key == 'language'
      || item.key == 'theme'
      || item.key == 'themeColor'
      || item.key == 'themeForegroundColor'
      || item.key == 'fontStyle'
      || item.key == 'maxHomePageWidth'
      || item.key == 'customBackgroundUrl'
      || item.key == 'hidePcEditor'
      || item.key == 'signinFooterEnabled'
      || item.key == 'signinFooterText'
    ) {
      //if user not login, then use frist find config
      if (!userId) {
        acc[item.key] = config.value;
        return acc;
      }
    }
    if (!isSuperAdmin && !item.userId) {
      return acc;
    }
    const isUserPreferConfig = ZUserPerferConfigKey.safeParse(item.key).success;
    if ((isUserPreferConfig && item.userId === userId) || (!isUserPreferConfig)) {
      acc[item.key] = config.value;
    }
    return acc;
  }, {} as Record<string, any>);

  return globalConfig as GlobalConfig;
};

export const getAiModelConfig = async (type: 'mainModel' | 'embeddingModel' | 'voiceModel' | 'rerankModel' | 'imageModel' | 'audioModel', ctx?: Context) => {
  // Map type to config key
  const configKey = `${type}Id`;

  // Get global config to find the model ID
  const globalConfig = await getGlobalConfig({ ctx });
  const modelId = globalConfig[configKey];

  if (!modelId) {
    return null;
  }

  // Get the model with provider information directly from prisma
  const model = await prisma.aiModels.findUnique({
    where: { id: modelId },
    include: { provider: true }
  });

  if (!model) {
    return null;
  }

  return {
    title: model.title,
    modelKey: model.modelKey,
    capabilities: model.capabilities,
    provider: {
      id: model.provider.id,
      title: model.provider.title,
      provider: model.provider.provider,
      baseURL: model.provider.baseURL,
      apiKey: model.provider.apiKey
    }
  };
};

export const configRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/config/list', summary: 'Query user config list', protect: true, tags: ['Config'] } })
    .input(z.void())
    .output(ZConfigSchema)
    .query(async function ({ ctx }) {
      return await getGlobalConfig({ ctx })
    }),
  update: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/config/update', summary: 'Update user config', protect: true, tags: ['Config'] } })
    .input(z.object({
      key: ZConfigKey,
      value: z.any()
    }))
    .output(configSchema)
    .mutation(async function ({ input, ctx }) {
      const userId = Number(ctx.id)
      const { key, value } = input
      const isUserPreferConfig = ZUserPerferConfigKey.safeParse(key).success;
      console.log('isUserPreferConfig', isUserPreferConfig)
      let updateResult;
      
      if (isUserPreferConfig) {
        const matchedConfigs = await prisma.config.findMany({ where: { userId, key } });
        
        if (matchedConfigs.length > 0) {
          const configToKeep = matchedConfigs[0];
          updateResult = await prisma.config.update({ 
            where: { id: configToKeep?.id }, 
            data: { config: { type: typeof value, value } } 
          });
          
          if (matchedConfigs.length > 1) {
            await prisma.config.deleteMany({
              where: {
                userId,
                key,
                id: { notIn: [configToKeep!.id!] }
              }
            });
          }
        } else {
          updateResult = await prisma.config.create({ data: { userId, key, config: { type: typeof value, value } } });
        }
      } else {
        if (ctx.role !== 'superadmin') {
          throw new Error('You are not allowed to update global config')
        }
        const matchedConfigs = await prisma.config.findMany({ where: { key } });
        
        if (matchedConfigs.length > 0) {
          const configToKeep = matchedConfigs[0];
          updateResult = await prisma.config.update({ 
            where: { id: configToKeep?.id }, 
            data: { config: { type: typeof value, value } } 
          });
          
          if (matchedConfigs.length > 1) {
            await prisma.config.deleteMany({
              where: {
                key,
                id: { notIn: [configToKeep!.id!] }
              }
            });
          }
        } else {
          updateResult = await prisma.config.create({ data: { key, config: { type: typeof value, value } } });
        }
      }

      // If updating OAuth2 providers, reinitialize OAuth strategies
      if (key === 'oauth2Providers') {
        try {
          const result = await reinitializeOAuthStrategies();
          console.log('OAuth strategies reinitialized after config update:', result);
        } catch (error) {
          console.error('Failed to reinitialize OAuth strategies after config update:', error);
          // Don't throw error here to avoid breaking the config update
        }
      }

      return updateResult;
    }),

  setPluginConfig: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/config/setPluginConfig', summary: 'Set plugin config', protect: true, tags: ['Config'] } })
    .input(z.object({
      pluginName: z.string(),
      key: z.string(),
      value: z.any()
    }))
    .output(z.any())
    .mutation(async function ({ input, ctx }) {
      const userId = Number(ctx.id)
      const { pluginName, key, value } = input
      const hasKey = await prisma.config.findFirst({ where: { userId, key: `plugin_config_${pluginName}_${key}` } })
      if (hasKey) {
        return await prisma.config.update({ where: { id: hasKey.id }, data: { config: { type: typeof value, value } } })
      }
      return await prisma.config.create({ data: { userId, key: `plugin_config_${pluginName}_${key}`, config: { type: typeof value, value } } })
    }),
  getPluginConfig: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/config/getPluginConfig', summary: 'Get plugin config', protect: true, tags: ['Config'] } })
    .input(z.object({
      pluginName: z.string()
    }))
    .output(z.any())
    .query(async function ({ input, ctx }) {
      const userId = Number(ctx.id)
      const { pluginName } = input
      const configs = await prisma.config.findMany({
        where: {
          userId,
          key: {
            contains: `plugin_config_${pluginName}_`
          }
        }
      })
      return configs.reduce((acc, item) => {
        const key = item.key.replace(`plugin_config_${pluginName}_`, '');
        acc[key] = (item.config as { value: any }).value;
        return acc;
      }, {} as Record<string, any>);
    }),

  ai: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/config/ai', summary: 'Get AI model configuration by type', protect: true, tags: ['Config'] } })
    .input(z.object({
      type: z.enum(['mainModel', 'embeddingModel', 'voiceModel', 'rerankModel', 'imageModel', 'audioModel'])
    }))
    .output(z.object({
      title: z.string(),
      modelKey: z.string(),
      capabilities: z.any(),
      provider: z.object({
        id: z.number(),
        title: z.string(),
        provider: z.string(),
        baseURL: z.string().nullable(),
        apiKey: z.string().nullable()
      })
    }).nullable())
    .query(async function ({ input, ctx }) {
      const { type } = input;

      const model = await getAiModelConfig(type, ctx);
      return model;
    })
})
