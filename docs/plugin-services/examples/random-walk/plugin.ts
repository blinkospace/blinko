/**
 * 最小示例一：随机漫步
 *
 * 只演示"从当前笔记出发，排除已经展示过的节点，再取下一批"。
 * 不含地图、分享卡、路径统计——那些是随机漫步插件自己的产品逻辑。
 * 只依赖正式 SDK（window.Blinko.services），不触碰任何后端模块。
 */
import type { BasePlugin } from 'blinko';
import type { PluginServicesSdk, VectorQueryItem } from 'blinko/services';

export default class RandomWalkPlugin implements BasePlugin {
  name = 'random-walk-example';
  displayName = { default: '随机漫步（示例）', zh: '随机漫步（示例）' };
  version = '0.1.0';

  /** 本次会话已经展示过的节点，用于排除。不持久化。 */
  private visited: number[] = [];

  /**
   * SDK 由外部注入，默认取宿主挂载的那个。
   * 可注入是为了能脱离宿主单独测：传一个假的 SDK 就能验交互，不用起前端。
   */
  constructor(private readonly services: PluginServicesSdk = window.Blinko.services) {}

  init(): void {
    // 能力探测：方法存在不等于服务可运行，必须先问。
    void this.next(1);
  }

  destroy(): void {
    this.visited = [];
  }

  /** 取下一跳候选。source 固定为笔记，excludeNoteIds 由本地会话维护。 */
  async next(noteId: number, limit = 5): Promise<VectorQueryItem[]> {
    const capabilities = await this.services.capabilities();
    if (!capabilities.features['vector.queryByNote']?.available) {
      // 诚实降级：宿主没提供就关掉功能，而不是调用后报错。
      return [];
    }

    const result = await this.services.vector.query({
      source: { kind: 'note', noteId },
      excludeNoteIds: [...this.visited, noteId],
      limit: Math.min(limit, capabilities.limits.maxResults),
      mode: 'exact',
    });

    // 只有有证据的精确全扫描才能说"没有更多"；其余情况保留 unknown。
    if (result.retrieval.remaining === 'no') {
      this.visited = [];
    }
    this.visited.push(noteId, ...result.items.map((item) => item.note.id));
    return result.items;
  }
}
