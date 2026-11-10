/**
 * 最小示例二：相似内容检查
 *
 * 演示用一段文本查语义相近的笔记，并按分数阈值过滤。
 * 文本查询可能产生 Embedding 费用，所以幂等键交给 SDK 生成，不手写 UUID。
 */
import type { BasePlugin } from 'blinko';
import type {
  PluginServicesSdk, VectorQueryItem, VectorQueryResult,
  ReadVectorSnapshotResult, VectorSnapshotDescriptor,
} from 'blinko/services';

export interface PreparedContentCheck {
  range: VectorSnapshotDescriptor['range'];
  result: VectorQueryResult;
  firstMatch: ReadVectorSnapshotResult | null;
}

export default class SimilarContentPlugin implements BasePlugin {
  name = 'similar-content-example';
  displayName = { default: '相似内容检查（示例）', zh: '相似内容检查（示例）' };
  version = '0.1.0';

  /** SDK 可注入，便于脱离宿主做独立测试。 */
  constructor(private readonly services: PluginServicesSdk = window.Blinko.services) {}

  lastPreparedCheck: PreparedContentCheck | null = null;
  private unsubscribe?: () => void;
  private pending?: AbortController;
  private sequence = 0;
  private destroyed = false;

  init(): void {
    this.unsubscribe?.();
    this.destroyed = false;
    let identityKey = this.services.context?.get().identityKey;
    // Local subscription only: no indexing, provider calls or background queries.
    this.unsubscribe = this.services.context?.subscribe(current => {
      if (current.identityKey !== identityKey) {
        identityKey = current.identityKey;
        this.sequence++;
        this.pending?.abort();
        this.lastPreparedCheck = null;
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.sequence++;
    this.pending?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.lastPreparedCheck = null;
  }

  /** Resolve a selected attachment without reading a host store or credential. */
  attachmentUrl(path: string): string | null {
    if (this.destroyed || this.services.context?.get().authentication !== 'authenticated') return null;
    return this.services.files?.url(path) ?? null;
  }

  /** Compare one existing note using only prepared vectors; this never encodes text. */
  async checkPreparedNote(noteId: number): Promise<PreparedContentCheck | null> {
    const context = this.services.context;
    if (!context || this.destroyed || context.get().authentication !== 'authenticated') return null;
    this.pending?.abort();
    const pending = this.pending = new AbortController();
    const sequence = ++this.sequence;
    const identityKey = context.get().identityKey;
    const current = () => !this.destroyed && sequence === this.sequence && context.get().identityKey === identityKey;
    const options = { signal: pending.signal };
    let snapshot: VectorSnapshotDescriptor | undefined;
    let report: PreparedContentCheck | null = null;
    this.lastPreparedCheck = null;
    try {
      const caps = await this.services.capabilities(options);
      if (!current() || !caps.features['vector.queryByNote']?.available ||
          !caps.features['vector.noteLevelAggregation']?.available ||
          !caps.features['vector.snapshots']?.available) return null;
      snapshot = await this.services.vector.snapshots.create({ aggregation: 'note_level_weighted_v1' }, options);
      if (!current()) return null;
      const result = await this.services.vector.query({
        source: { kind: 'note', noteId }, snapshotHandle: snapshot.handle,
        aggregation: 'note_level_weighted_v1',
        expectedIndex: { embeddingSpaceId: snapshot.index.embeddingSpaceId, generation: snapshot.index.generation },
        excludeNoteIds: [noteId], limit: 10, mode: 'exact',
      }, options);
      if (!current()) return null;
      if (result.scoring.aggregation !== snapshot.scoring.aggregation ||
          result.scoring.version !== snapshot.scoring.version ||
          result.index.embeddingSpaceId !== snapshot.index.embeddingSpaceId ||
          result.index.generation !== snapshot.index.generation ||
          result.index.corpusRevision !== snapshot.index.corpusRevision) {
        throw new Error('Prepared comparison returned an inconsistent scoring/index version.');
      }
      let firstMatch: ReadVectorSnapshotResult | null = null;
      const first = result.items[0];
      if (first) {
        if (first.snapshot?.handle !== snapshot.handle) throw new Error('The match has no matching snapshot reference.');
        firstMatch = await this.services.vector.snapshots.readNote({
          handle: snapshot.handle, noteId: first.note.id, snapshotHash: first.snapshot.hash,
        }, options);
      }
      if (!current()) return null;
      // Preserve partial/unknown retrieval and changed/missing/forbidden body
      // states. Neither an empty result nor this prepared subset proves exhaustion.
      report = { range: snapshot.range, result, firstMatch };
    } finally {
      if (snapshot && context.get().identityKey === identityKey) {
        // Never release an old account's handle using a replacement login. If
        // cleanup is refused/unavailable, the host's bounded lease still expires.
        await this.services.vector.snapshots.release({ handle: snapshot.handle }).catch(() => {});
      }
      if (this.pending === pending) this.pending = undefined;
    }
    if (!current()) return null;
    return this.lastPreparedCheck = report;
  }

  /** 检查一段草稿与已有笔记的重复度。 */
  async check(text: string, minScore = 0.75): Promise<VectorQueryItem[]> {
    const capabilities = await this.services.capabilities();
    if (!capabilities.features['vector.queryByText']?.available) {
      return [];
    }

    const result = await this.services.vector.query({
      source: { kind: 'text', text },
      minScore,
      limit: 10,
      mode: 'exact',
      // idempotencyKey 省略时 SDK 会补一个；显式重试同一逻辑调用才复用。
    });

    // score 是余弦相似度 [-1, 1]，不是概率，别显示成百分比。
    return result.items.filter((item) => item.score >= minScore);
  }
}
