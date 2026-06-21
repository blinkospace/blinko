const CJK_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const PUNCTUATION_REGEX = /[\p{P}\p{S}]/gu;

export const getCharCount = (content?: string | null): number => {
  if (!content) return 0;
  return content.trim().length;
};

export const getCharCountWithoutPunctuation = (content?: string | null): number => {
  if (!content) return 0;
  return content.trim().replace(PUNCTUATION_REGEX, '').length;
};

export const hasCJKText = (content?: string | null): boolean => {
  if (!content) return false;
  return CJK_REGEX.test(content);
};

export const getTextCountLabelKey = (content?: string | null): 'word-count' | 'char-count' => {
  return hasCJKText(content) ? 'word-count' : 'char-count';
};

export const getTextCountDisplay = (
  content?: string | null,
  options?: { includePunctuation?: boolean }
): { count: number; labelKey: 'word-count' | 'char-count' } => {
  const includePunctuation = options?.includePunctuation ?? false;

  return {
    count: includePunctuation ? getCharCount(content) : getCharCountWithoutPunctuation(content),
    labelKey: getTextCountLabelKey(content)
  };
};
