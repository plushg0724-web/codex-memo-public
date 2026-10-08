import type {createToolPool} from './appserver.cjs';
import {PREFIX, decode} from './backup-format.cjs';
import {isRecord} from './backup-types.cjs';
import type {BackupDocument, BackupEnvelope, BackupItem, BackupList} from './backup-types.cjs';

type ToolPool = ReturnType<typeof createToolPool>;

export function createBackupSpace(pool: ToolPool): {
  create(document: BackupDocument): Promise<BackupItem>;
  list(force?: boolean): Promise<BackupList>;
  read(pageId: string): Promise<BackupEnvelope>;
} {
  let cached: BackupList | null = null;
  return {
    async create(document) {
      const result: unknown = await pool.run(call => call('chatgpt_space.create_page', {
        title: document.title, initial_blocks: [document.markdown],
      }));
      const page = isRecord(result) ? result : {};
      const metadata = isRecord(page.metadata) ? page.metadata : {};
      const pageId = [metadata.page_id, page.page_id, page.id].find((value): value is string => typeof value === 'string' && !!value);
      if (!pageId) throw Error('백업 페이지 식별자를 받지 못했습니다. 백업 목록에서 저장 여부를 확인하세요.');
      const url = [metadata.url, page.url].find((value): value is string => typeof value === 'string' && !!value);
      const item: BackupItem = {
        pageId, title: document.title, createdAt: document.envelope.createdAt,
        deviceId: document.envelope.deviceId, counts: document.envelope.counts,
        url: url || `https://chatgpt.com/space/${pageId}`,
      };
      if (cached) cached.items = [item, ...cached.items.filter(page => page.pageId !== pageId)];
      return item;
    },
    async list(force = false) {
      if (!force && cached && Date.now() - cached.at < 30000) return {...cached, cached: true};
      return pool.run(async call => {
        const pages = new Map<string, BackupItem>(), cursors = new Set<string>();
        let cursor: string | undefined, partial = false;
        for (let n = 0; n < 20; n++) {
          const result: unknown = await call('chatgpt_space.find_pages', {query: PREFIX, ...(cursor ? {cursor} : {})});
          if (!isRecord(result)) throw Error('백업 목록 응답을 읽을 수 없습니다.');
          partial ||= !!result.partial_results || (Array.isArray(result.incomplete_reasons) && result.incomplete_reasons.length > 0);
          const items: unknown[] = Array.isArray(result.items) ? result.items : [];
          for (const page of items) {
            if (!isRecord(page) || typeof page.title !== 'string' || !page.title.startsWith(PREFIX + ' · ') ||
                (isRecord(page.access) && page.access.can_read === false) || typeof page.page_id !== 'string' || !page.page_id) continue;
            const segments = page.title.split(' · ');
            pages.set(page.page_id, {
              pageId: page.page_id, title: page.title,
              createdAt: typeof page.created_at === 'string' && page.created_at ? page.created_at : segments.at(-1) || '',
              deviceId: segments.slice(1, -1).join(' · '),
              ...(typeof page.url === 'string' ? {url: page.url} : {}),
            });
          }
          cursor = typeof result.next_cursor === 'string' ? result.next_cursor : undefined;
          if (!cursor) break;
          if (cursors.has(cursor)) { partial = true; break; }
          cursors.add(cursor);
        }
        if (cursor) partial = true;
        const items = [...pages.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        cached = {items, partial, at: Date.now()};
        return cached;
      });
    },
    async read(pageId) {
      const page: unknown = await pool.run(call => call('chatgpt_space.read_page', {page_id: pageId, view: 'full'}));
      return decode(page);
    },
  };
}
