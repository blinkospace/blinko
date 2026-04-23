import { type Tag } from '@shared/lib/types';
import { _ } from './lodash';
import i18n from './i18n';
import { FileType } from '@/components/Common/Editor/type';
import dayjs from 'dayjs';
import { GlobalConfig } from '@shared/lib/types';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { UserStore } from '@/store/user';

const valMap = {
  undefined: '',
  null: '',
  false: false,
};
export interface TagTreeNode {
  name: string;
  children?: TagTreeNode[];
}
export type TagTreeDBNode = Tag & { children?: TagTreeDBNode[]; metadata: { icon: string, path: string, noteCount?: number } }
export const helper = {
  regex: {
    isEndsWithHashTag: /#[/\w\p{L}\p{N}]*$/u,
    //lookbehind assertions in ios regex is not supported
    isContainHashTag: /#[^\s#]*(?:[*?.。]|$)/g
  },
  assemblyPageResult<T>(args: { data: T[], page: number, size: number, result: T[] }): { result: T[], isLoadAll: boolean, isEmpty: boolean } {
    const { data, page, size } = args
    let result = args.result
    let isLoadAll = false
    if (data.length == size) {
      if (page == 1) {
        result = data
      } else {
        result = result.concat(data)
      }
    } else {
      if (page == 1) {
        result = data
      } else {
        result = result.concat(data)
        isLoadAll = true
      }
    }
    return { result, isLoadAll, isEmpty: data.length == 0 }
  },
  extractHashtags(input: string): string[] {
    const hashtagRegex = /#[^\s#]*(?:[*?.。]|$)/g;
    const matches = input.match(hashtagRegex);
    return matches ? matches : [];
  },
  buildHashTagTreeFromHashString(paths: string[]): TagTreeNode[] {
    const root: TagTreeNode[] = [];
    function insertIntoTree(pathArray: string[], nodes: TagTreeNode[]): void {
      if (pathArray.length === 0) return;
      const currentName = pathArray[0];
      let node = nodes.find(n => n.name === currentName);
      if (!node) {
        node = { name: currentName! };
        nodes.push(node);
      }
      if (pathArray.length > 1) {
        if (!node.children) {
          node.children = [];
        }
        insertIntoTree(pathArray.slice(1), node.children);
      }
    }
    for (const path of paths) {
      const pathArray = path.replace(/#/g, '').split('/');
      insertIntoTree(pathArray, root);
    }
    return root;
  },
  buildHashTagTreeFromDb(tags: Tag[]) {
    const map: Record<number, TagTreeDBNode> = {};
    const roots: TagTreeDBNode[] = [];
    tags.forEach(tag => {
      map[tag.id] = { ...tag, children: [], metadata: { icon: tag.icon, path: '', noteCount: tag._count?.tagsToNote ?? 0 } };
    });
    function buildPath(tagId: number): string {
      const tag = map[tagId];
      if (!tag) return '';
      if (tag.parent && tag.parent !== 0) {
        const parentPath = buildPath(tag.parent);
        return parentPath ? `${parentPath}/${tag.name}` : tag.name;
      }
      return tag.name;
    }
    tags.forEach(tag => {
      const currentNode = map[tag.id];
      currentNode!.metadata.path = buildPath(tag.id);
      if (tag.parent === 0) {
        roots.push(currentNode!);
      } else {
        if (map[tag.parent]) {
          map[tag.parent]?.children?.push(currentNode!);
        }
      }
    });
    roots.sort((a, b) => a.sortOrder - b.sortOrder);
    const sortChildren = (node: TagTreeDBNode) => {
      if (node.children && node.children.length > 0) {
        node.children.sort((a, b) => a.sortOrder - b.sortOrder);
        node.children.forEach(sortChildren);
      }
    };
    roots.forEach(sortChildren);
    return roots;
  },
  // Filter tags with zero note count (but keep parent tags if children have notes)
  filterEmptyTags(nodes: TagTreeDBNode[]): TagTreeDBNode[] {
    return nodes.filter(node => {
      // Filter children first
      if (node.children && node.children.length > 0) {
        node.children = this.filterEmptyTags(node.children);
      }
      // Keep node if it has notes or has children with notes
      const hasNotes = (node.metadata.noteCount ?? 0) > 0;
      const hasChildrenWithNotes = node.children && node.children.length > 0;
      return hasNotes || hasChildrenWithNotes;
    });
  },
  generateTagPaths(node: TagTreeDBNode, parentPath: string = ''): string[] {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const paths: string[] = [`${currentPath}`];
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        paths.push(...helper.generateTagPaths(child, currentPath));
      }
    }
    return paths;
  },
  getFileExtension(filename: string): string | null {
    const parts = filename.split('.');
    if (parts.length > 1) {
      return parts.pop() || null;
    }
    return null
  },
  getFileType(mimeType: string, filename: string): FileType['previewType'] {
    const extension = helper.getFileExtension(filename) ?? ''

    if (mimeType != '') {
      if (mimeType?.startsWith('audio')) return 'audio'
      if (mimeType?.startsWith('video')) return 'video'
      if (mimeType?.startsWith('image')) return 'image'
    }

    if ('jpeg/jpg/png/bmp/tiff/tif/webp/svg'.includes(extension?.toLowerCase() ?? null)) {
      return 'image'
    }
    if ('mp4/webm/ogg/mov/wmv'.includes(extension?.toLowerCase() ?? null)) {
      return 'video';
    }
    if ('mp3/aac/wav/ogg'.includes(extension?.toLowerCase() ?? null)) {
      return 'audio';
    }
    return 'other'
  },
  promise: {
    async sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    async runAsync<T, U = Error>(promise: Promise<T>): Promise<[U | null, T | null]> {
      return promise.then<[null, T]>((data: T) => [null, data]).catch<[U, null]>((err) => [err, null]);
    },
  },
  object: {
    crawlObject(object, options) {
      const newObj = JSON.parse(JSON.stringify(object));
      return helper.object.crawl(newObj, options);
    },
    crawl(object, options) {
      Object.keys(object).forEach((i) => {
        if (typeof object[i] === 'object') {
          helper.object.crawl(object[i], options);
        } else {
          const handler = options[typeof object[i]];
          if (handler) {
            object[i] = handler(object[i]);
          }
        }
      });
      return object;
    },
  },
  json: {
    isJsonString(str: string) {
      if (!str || typeof str !== 'string') return false;
      if (!str?.includes('{')) return false;
      try {
        JSON.parse(str);
      } catch (e) {
        return false;
      }
      return true;
    },
    safeParse(val: any) {
      try {
        return JSON.parse(val);
      } catch (error) {
        return val;
      }
    },
  },
  deepAssign(target, ...sources) {
    sources.forEach((source) => {
      Object.keys(source).forEach((key) => {
        let descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor && descriptor?.get) {
          return Object.defineProperty(target, key, descriptor);
        }
        const targetValue = target[key];
        let sourceValue = source[key];
        if (helper.isObject(targetValue) && helper.isObject(sourceValue)) {
          try {
            target[key] = helper.deepAssign(targetValue, sourceValue);
          } catch (e) {
            target[key] = Object.assign(targetValue, sourceValue);
          }
        } else {
          target[key] = sourceValue;
        }
      });
    });
    return target;
  },
  isObject(value) {
    return value != null && typeof value === 'object';
  },
  download: {
    downloadByBlob(name: string, blob: Blob) {
      const a = document.createElement('a');
      const href = window.URL.createObjectURL(blob);
      a.href = href;
      a.download = name;
      a.click();
    },
    downloadByLink(href: string) {
      const a = document.createElement('a');
      a.href = href + '?download=true&token='+RootStore.Get(UserStore).tokenData?.value?.token;
      a.click();
    },
  },
  env: {
    //@ts-ignore
    isBrowser: typeof window === 'undefined' ? false : true,
    isIOS: () => {
      try {
        const userAgent = window.navigator.userAgent.toLowerCase();
        const isIPad = /ipad/.test(userAgent);
        const isIPhone = /iphone/.test(userAgent);
        const isIPod = /ipod/.test(userAgent);
        const isMacOS = /macintosh/.test(userAgent) && navigator.maxTouchPoints > 0;
        return isIPad || isIPhone || isIPod || isMacOS;
      } catch (error) {
        return false
      }
    }
  },
  cron: {
    human(cronTime: string) {
      switch (cronTime) {
        // case ''
        // every 1 mintins for test
        // case '*/1 * * * *':
        //   return i18n.t('every-1-minutes')
        case '0 0 * * *':
          return i18n.t('every-day')
        case '0 0 * * 0':
          return i18n.t('every-week')
        case '0 0 1 * *':
          return i18n.t('every-month')
        case '0 0 1 */3 *':
          return i18n.t('every-three-month')
        case '0 0 1 */6 *':
          return i18n.t('every-half-year')
      }
    },
    cornTimeList: [
      ...(process.env.NODE_ENV == 'development' ? [{
        label: '10 seconds',
        value: '*/10 * * * * *'
      }] : []),
      {
        label: i18n.t('every-day'),
        value: '0 0 * * *'
      },
      {
        label: i18n.t('every-week'),
        value: '0 0 * * 0'
      },
      {
        label: i18n.t('every-month'),
        value: '0 0 1 * *'
      },
      {
        label: i18n.t('every-three-month'),
        value: '0 0 1 */3 *'
      },
      {
        label: i18n.t('every-half-year'),
        value: '0 0 1 */6 *'
      }
    ]
  }
};

export const formatTime = (
  time: Date | string | number | undefined,
  config: Partial<GlobalConfig>
) => {
  if (!time) return '';
  const date = dayjs(time);
  return config?.timeFormat === 'relative'
    ? date.fromNow()
    : date.format(config?.timeFormat ?? 'YYYY-MM-DD HH:mm:ss');
};

export const getDisplayTime = (
  createdAt: Date | string | number | undefined,
  updatedAt: Date | string | number | undefined,
) => {
  const config = (RootStore.Get(BlinkoStore).config.value || {}) as Partial<GlobalConfig>;
  const timeToShow = config.isOrderByCreateTime ? createdAt : updatedAt;
  return formatTime(timeToShow, config);
};
