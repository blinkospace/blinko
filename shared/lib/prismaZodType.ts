import { Prisma } from "@prisma/client"
import { z } from "zod"

/////////////////////////////////////////
// ACCOUNTS SCHEMA
/////////////////////////////////////////

export const accountsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  nickname: z.string(),
  password: z.string(),
  image: z.string(),
  apiToken: z.string(),
  note: z.number().int(),
  role: z.string(),
  loginType: z.string().optional(),
  description: z.string().optional(),
  linkAccountId: z.number().int().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type accounts = z.infer<typeof accountsSchema>

/////////////////////////////////////////
// ATTACHMENTS SCHEMA
/////////////////////////////////////////

export const attachmentsSchema = z.object({
  id: z.number().int(),
  isShare: z.boolean(),
  sharePassword: z.string(),
  name: z.string(),
  path: z.string(),
  size: z.any(),
  noteId: z.number().int().nullable(),
  accountId: z.number().int().nullable(),
  createdAt: z.coerce.date(),
  sortOrder: z.number().int(),
  updatedAt: z.coerce.date(),
  type: z.string(),
  depth: z.any(),
  perfixPath: z.any(),
  metadata: z.any().optional()
})

export type attachments = z.infer<typeof attachmentsSchema>

/////////////////////////////////////////
// CONFIG SCHEMA
/////////////////////////////////////////

export const configSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  config: z.any(),
})

export type config = z.infer<typeof configSchema>

/////////////////////////////////////////
// NOTES SCHEMA
/////////////////////////////////////////

export const notesSchema = z.object({
  id: z.number().int(),
  type: z.number().int(),
  content: z.string(),
  isArchived: z.boolean(),
  isRecycle: z.boolean(),
  isShare: z.boolean(),
  isTop: z.boolean(),
  isReviewed: z.boolean(),
  sharePassword: z.string(),
  shareEncryptedUrl: z.string().nullable().optional(),
  shareExpiryDate: z.date().nullable().optional(),
  shareMaxView: z.number().nullable().optional(),
  shareViewCount: z.number().nullable().optional(),
  metadata: z.any(),
  sortOrder: z.number().nullable().optional(),
  accountId: z.union([z.number().int(), z.null()]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type notes = z.infer<typeof notesSchema>

/////////////////////////////////////////
// TAG SCHEMA
/////////////////////////////////////////

export const tagSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  icon: z.string(),
  parent: z.number().int(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type tag = z.infer<typeof tagSchema>

/////////////////////////////////////////
// TAGS TO NOTE SCHEMA
/////////////////////////////////////////

export const tagsToNoteSchema = z.object({
  id: z.number().int(),
  noteId: z.number().int(),
  tagId: z.number().int(),
})

export type tagsToNote = z.infer<typeof tagsToNoteSchema>

/////////////////////////////////////////
// SELECT & INCLUDE
/////////////////////////////////////////

// ACCOUNTS
//------------------------------------------------------

export const accountsSelectSchema: z.ZodType<Prisma.accountsSelect> = z.object({
  id: z.boolean().optional(),
  name: z.boolean().optional(),
  nickname: z.boolean().optional(),
  password: z.boolean().optional(),
  image: z.boolean().optional(),
  apiToken: z.boolean().optional(),
  note: z.boolean().optional(),
  role: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
}).strict()

// ATTACHMENTS
//------------------------------------------------------


// CONFIG
//------------------------------------------------------

export const configSelectSchema: z.ZodType<Prisma.configSelect> = z.object({
  id: z.boolean().optional(),
  key: z.boolean().optional(),
  config: z.boolean().optional(),
}).strict()

// AI PROVIDERS
//------------------------------------------------------

export const aiProvidersSelectSchema: z.ZodType<Prisma.aiProvidersSelect> = z.object({
  id: z.boolean().optional(),
  title: z.boolean().optional(),
  provider: z.boolean().optional(),
  baseURL: z.boolean().optional(),
  apiKey: z.boolean().optional(),
  config: z.boolean().optional(),
  sortOrder: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
  models: z.boolean().optional(),
}).strict()

export const aiProvidersIncludeSchema: z.ZodType<Prisma.aiProvidersInclude> = z.object({
  models: z.boolean().optional(),
}).strict()

// AI MODELS
//------------------------------------------------------

export const aiModelsSelectSchema: z.ZodType<Prisma.aiModelsSelect> = z.object({
  id: z.boolean().optional(),
  providerId: z.boolean().optional(),
  title: z.boolean().optional(),
  modelKey: z.boolean().optional(),
  capabilities: z.boolean().optional(),
  config: z.boolean().optional(),
  sortOrder: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
  provider: z.boolean().optional(),
}).strict()

export const aiModelsIncludeSchema: z.ZodType<Prisma.aiModelsInclude> = z.object({
  provider: z.boolean().optional(),
}).strict()

// NOTE REFERENCE
//------------------------------------------------------

export const noteReferenceSchema = z.object({
  id: z.number().int(),
  fromNoteId: z.number().int(),
  toNoteId: z.number().int(),
})

/////////////////////////////////////////
// COMMENTS SCHEMA
/////////////////////////////////////////

export const commentsSchema = z.object({
  id: z.number().int(),
  content: z.string(),
  accountId: z.number().int().nullable(),
  guestName: z.string().nullable(),
  guestIP: z.string().nullable(),
  guestUA: z.string().nullable(),
  noteId: z.number().int(),
  parentId: z.number().int().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type comments = z.infer<typeof commentsSchema>


/////////////////////////////////////////
// FOLLOWS SCHEMA
/////////////////////////////////////////

export const followsSchema = z.object({
  id: z.number().int(),
  siteName: z.string().optional(),
  siteUrl: z.string(),
  siteAvatar: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  followType: z.string(),
  accountId: z.number().int(),
})

export type follows = z.infer<typeof followsSchema>

/////////////////////////////////////////
// NOTIFICATIONS SCHEMA
/////////////////////////////////////////
export const NotificationType = {
  FOLLOW: 'follow',
  COMMENT: 'comment',
  SYSTEM: 'system',
} as const

export const notificationType = z.union([
  z.enum([
    NotificationType.FOLLOW,
    NotificationType.COMMENT,
    NotificationType.SYSTEM,
  ]),
  z.string()
])

export const notificationsSchema = z.object({
  id: z.number().int(),
  type: notificationType,
  title: z.string(),
  content: z.string(),
  metadata: z.any(),
  isRead: z.boolean(),
  accountId: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type Notifications = z.infer<typeof notificationsSchema>
export type InputNotificationType = z.infer<typeof notificationType>

/////////////////////////////////////////
// CACHE SCHEMA
/////////////////////////////////////////

export const cacheSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  value: z.any(),
})


/////////////////////////////////////////
// PLUGIN SCHEMA
// /////////////////////////////////////////

export const pluginSchema = z.object({
  id: z.number().int(),
  metadata: z.any(),
  path: z.string(),
  isUse: z.boolean(),
  isDev: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type plugin = z.infer<typeof pluginSchema>


/////////////////////////////////////////
// CONVERSATION SCHEMA
/////////////////////////////////////////

export const conversationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  accountId: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type conversation = z.infer<typeof conversationSchema>

/////////////////////////////////////////
// MESSAGE SCHEMA
/////////////////////////////////////////

export const messageSchema = z.object({
  id: z.number().int(),
  content: z.string(),
  role: z.string(),
  conversationId: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  metadata: z.any(),
})

export type message = z.infer<typeof messageSchema>


/////////////////////////////////////////
// HISTORY SCHEMA
/////////////////////////////////////////

export const historySchema = z.object({
  id: z.number().int(),
  content: z.string(),
  noteId: z.number().int(),
  createdAt: z.coerce.date(),
  version: z.number().int().optional(),
  accountId: z.number().int().nullable()
})

export type history = z.infer<typeof historySchema>


/////////////////////////////////////////
// Note Internal Share
/////////////////////////////////////////

export const noteInternalShareSchema = z.object({
  id: z.number().int(),
  noteId: z.number().int(),
  accountId: z.number().int(),
  canEdit: z.boolean(),
})

export type noteInternalShare = z.infer<typeof noteInternalShareSchema>

/////////////////////////////////////////
// AI PROVIDERS SCHEMA
/////////////////////////////////////////

export const aiProvidersSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  provider: z.string(),
  baseURL: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  config: z.any().nullable().optional(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type aiProviders = z.infer<typeof aiProvidersSchema>

/////////////////////////////////////////
// AI MODELS SCHEMA
/////////////////////////////////////////

export const aiModelsSchema = z.object({
  id: z.number().int(),
  providerId: z.number().int(),
  title: z.string(),
  modelKey: z.string(),
  capabilities: z.any(),
  config: z.any().nullable().optional(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type aiModels = z.infer<typeof aiModelsSchema>

/////////////////////////////////////////
// AI SCHEDULED TASK SCHEMA
/////////////////////////////////////////

export const aiScheduledTaskSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  prompt: z.string(),
  schedule: z.string(),
  isEnabled: z.boolean(),
  lastRun: z.coerce.date().nullable().optional(),
  lastResult: z.any().nullable().optional(),
  accountId: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type aiScheduledTask = z.infer<typeof aiScheduledTaskSchema>

