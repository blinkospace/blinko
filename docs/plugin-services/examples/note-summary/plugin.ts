/**
 * 最小示例三：选定笔记摘要
 *
 * 演示用宿主已配置的生成模型，对用户明确指定的一篇笔记做摘要。
 * 不加载 RAG、不联网、不写笔记；contextNoteIds 逐条鉴权，无权即整体失败。
 */
import type { BasePlugin } from 'blinko';
import type { PluginServicesSdk } from 'blinko/services';

export default class NoteSummaryPlugin implements BasePlugin {
  name = 'note-summary-example';
  displayName = { default: '选定笔记摘要（示例）', zh: '选定笔记摘要（示例）' };
  version = '0.1.0';

  /** SDK 可注入，便于脱离宿主做独立测试。 */
  constructor(private readonly services: PluginServicesSdk = window.Blinko.services) {}

  init(): void {
    /* 由用户点击触发 */
  }

  destroy(): void {}

  async summarize(noteId: number): Promise<string | null> {
    const capabilities = await this.services.capabilities();
    if (!capabilities.features['ai.generateText']?.available) {
      return null;
    }

    const models = await this.services.ai.listModels();
    if (models.length === 0) {
      return null;
    }

    // 目录里的 default 可能已被白名单排除，而另一台模型仍然获准。
    // 直接发 'default' 会让摘要在这种配置下必然失败，所以取目录里实际可用的那一台。
    const model = models.find((item) => item.isDefault) ?? models[0];

    const result = await this.services.ai.generateText({
      modelId: model.id,
      system: '你是一个简洁的笔记摘要助手。只输出摘要正文。',
      messages: [{ role: 'user', content: '概括这篇笔记的核心观点，不超过 80 字。' }],
      contextNoteIds: [noteId],
      maxOutputTokens: 256,
      // 生成一定是付费调用，幂等键必填；SDK 会拒绝空串。
      idempotencyKey: '',
    });

    // 已成功但结果未保留时宿主会抛 RESULT_NOT_RETAINED，不重复调用模型。
    return result.text || null;
  }
}
