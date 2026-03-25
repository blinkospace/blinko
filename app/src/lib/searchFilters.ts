import type { BlinkoStore } from '@/store/blinkoStore';

const SEARCH_FILTER_QUERY_KEYS = ['searchText', 'tagId', 'withoutTag', 'withFile', 'withLink', 'hasTodo'] as const;

export const clearSearchState = (blinkoStore: BlinkoStore) => {
  blinkoStore.searchText = '';
  blinkoStore.globalSearchTerm = '';
  blinkoStore.noteListFilterConfig.tagId = null;
  blinkoStore.noteListFilterConfig.withoutTag = false;
  blinkoStore.noteListFilterConfig.withFile = false;
  blinkoStore.noteListFilterConfig.withLink = false;
  blinkoStore.noteListFilterConfig.hasTodo = false;
};

export const getSearchWithClearedFilters = (searchParams: URLSearchParams) => {
  const nextSearchParams = new URLSearchParams(searchParams);

  SEARCH_FILTER_QUERY_KEYS.forEach((key) => {
    nextSearchParams.delete(key);
  });

  const search = nextSearchParams.toString();
  return search ? `?${search}` : '';
};
