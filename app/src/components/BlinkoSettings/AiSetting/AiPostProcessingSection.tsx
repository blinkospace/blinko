import { observer } from 'mobx-react-lite';
import { Switch, Select, SelectItem, Textarea, Button, Tooltip } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { CollapsibleCard } from '../../Common/CollapsibleCard';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import { Item, ItemWithTooltip } from '../Item';
import { useMediaQuery } from 'usehooks-ts';

export const AiPostProcessingSection = observer(() => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore);
  const isPc = useMediaQuery('(min-width: 768px)');

  const [isUseAiPostProcessing, setIsUseAiPostProcessing] = useState(false);
  const [aiPostProcessingMode, setAiPostProcessingMode] = useState('comment');
  const [aiCommentPrompt, setAiCommentPrompt] = useState('');
  const [aiTagsPrompt, setAiTagsPrompt] = useState('');
  const [aiSmartEditPrompt, setAiSmartEditPrompt] = useState('');
  const [aiCustomPrompt, setAiCustomPrompt] = useState('');

  useEffect(() => {
    blinko.config.call();
  }, []);

  useEffect(() => {
    if (blinko.config.value) {
      setIsUseAiPostProcessing(blinko.config.value.isUseAiPostProcessing || false);
      setAiPostProcessingMode(blinko.config.value.aiPostProcessingMode || 'comment');
      setAiCommentPrompt(blinko.config.value.aiCommentPrompt || '');
      setAiTagsPrompt(blinko.config.value.aiTagsPrompt || '');
      setAiSmartEditPrompt(blinko.config.value.aiSmartEditPrompt || '');
      setAiCustomPrompt(blinko.config.value.aiCustomPrompt || '');
    }
  }, [blinko.config.value]);

  const updateConfig = (key: string, value: any) => {
    PromiseCall(
      api.config.update.mutate({ key, value }),
      { autoAlert: false }
    ).then(() => {
      blinko.config.call();
    });
  };

  return (
    <CollapsibleCard icon="hugeicons:ai-innovation-01" title="AI Post Processing">
      <Item
        leftContent={
          <ItemWithTooltip
            content={<>{t('enable-ai-post-processing')}</>}
            toolTipContent={
              <div className="w-[300px] flex flex-col gap-2">
                <div>
                  {t('note-processing-automatic-help')}
                </div>
                <div>
                  {t('can-generate-summaries-tags-or-perform-analysis')}
                </div>
              </div>
            }
          />
        }
        rightContent={
          <Switch
            isSelected={isUseAiPostProcessing}
            onChange={(e) => {
              const checked = e.target.checked;
              setIsUseAiPostProcessing(checked);
              updateConfig('isUseAiPostProcessing', checked);
            }}
          />
        }
      />

      <p className="px-2 text-xs text-default-500">{t('note-processing-voice-help')}</p>

      {isUseAiPostProcessing && (
        <>
          <Item
            type={isPc ? 'row' : 'col'}
            leftContent={
              <div className="flex flex-col gap-1">
                <div>{t('ai-post-processing-mode')}</div>
                <div className="text-[12px] text-default-400">{t('choose-what-to-do-with-ai-results')}</div>
              </div>
            }
            rightContent={
              <Select
                radius="lg"
                selectedKeys={[aiPostProcessingMode]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as string;
                  setAiPostProcessingMode(value);
                  updateConfig('aiPostProcessingMode', value);
                }}
                size="sm"
                className="w-[200px]"
              >
                <SelectItem key="comment" startContent={<Icon icon="tabler:message" />}>
                  {t('add-as-comment')}
                </SelectItem>
                <SelectItem key="tags" startContent={<Icon icon="tabler:tags" />}>
                  {t('auto-add-tags')}
                </SelectItem>
                <SelectItem key="smartEdit" startContent={<Icon icon="tabler:robot" />}>
                  {t('smart-edit')}
                </SelectItem>
                <SelectItem key="both" startContent={<Icon icon="tabler:analyze" />}>
                  {t('both')}
                </SelectItem>
                <SelectItem key="custom" startContent={<Icon icon="tabler:code" />}>
                  {t('custom')}
                </SelectItem>
              </Select>
            }
          />

          {(aiPostProcessingMode === 'comment' || aiPostProcessingMode === 'both') && (
            <Item
              type={isPc ? 'row' : 'col'}
              leftContent={
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {t('ai-post-processing-prompt')}
                    <Tooltip
                      content={
                        <div className="w-[300px] flex flex-col gap-2">
                          <div>{t('define-custom-prompt-for-ai-to-process-notes')}</div>
                        </div>
                      }
                    >
                      <Icon icon="proicons:info" width="18" height="18" />
                    </Tooltip>
                  </div>
                  <div className="text-[12px] text-default-400">{t('prompt-used-for-post-processing-notes')}</div>
                </div>
              }
              rightContent={
                <Textarea
                  radius="lg"
                  value={aiCommentPrompt || t('analyze-the-following-note-content-and-suggest-appropriate-tags-and-provide-a-brief-summary')}
                  onBlur={(e) => {
                    updateConfig('aiCommentPrompt', e.target.value);
                  }}
                  onChange={(e) => {
                    setAiCommentPrompt(e.target.value);
                  }}
                  placeholder={t('enter-custom-prompt-for-post-processing')}
                  className="w-full"
                />
              }
            />
          )}

          {(aiPostProcessingMode === 'tags' || aiPostProcessingMode === 'both') && (
            <Item
              type={isPc ? 'row' : 'col'}
              leftContent={
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {t('tags-prompt')}
                  </div>
                  <div className="text-[12px] text-default-400">{t('greater-than-prompt-used-for-auto-generating-tags-if-set-empty-the-default-prompt-will-be-used')}</div>
                </div>
              }
              rightContent={
                <Textarea
                  radius="lg"
                  value={aiTagsPrompt || `You are a precise label classification expert, and you will generate precisely matched content labels based on the content. Rules:
      1. **Core Selection Principle**: Select 5 to 8 tags from the existing tag list that are most relevant to the content theme. Carefully compare the key information, technical types, application scenarios, and other elements of the content to ensure that the selected tags accurately reflect the main idea of the content.
      2. **Language Matching Strategy**: If the language of the existing tags does not match the language of the content, give priority to using the language of the existing tags to maintain the consistency of the language style of the tag system.
      3. **Tag Structure Requirements**: When using existing tags, it is necessary to construct a parent-child hierarchical structure. For example, place programming language tags under parent tags such as #Code or #Programming, like #Code/JavaScript, #Programming/Python. When adding new tags, try to classify them under appropriate existing parent tags as well.
      4. **New Tag Generation Rules**: If there are no tags in the existing list that match the content, create new tags based on the key technologies, business fields, functional features, etc. of the content. The language of the new tags should be consistent with that of the content.
      5. **Response Format Specification**: Only return tags separated by commas. There should be no spaces between tags, and no formatting or code blocks should be used. Each tag should start with #, such as #JavaScript.
      6. **Example**: For JavaScript content related to web development, a reference response could be #Programming/Languages, #Web/Development, #Code/JavaScript, #Front-End Development/Frameworks (if applicable), #Browser Compatibility. It is strictly prohibited to respond in formats such as code blocks, JSON, or Markdown. Just provide the tags directly.
         `}
                  onBlur={(e) => {
                    updateConfig('aiTagsPrompt', e.target.value);
                  }}
                  onChange={(e) => {
                    setAiTagsPrompt(e.target.value);
                  }}
                  placeholder="Enter custom prompt for auto-generating tags"
                  className="w-full md:w-[400px]"
                />
              }
            />
          )}

          {aiPostProcessingMode === 'smartEdit' && (
            <Item
              type={isPc ? 'row' : 'col'}
              leftContent={
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {t('smart-edit-prompt')}
                    <Tooltip
                      content={
                        <div className="w-[300px] flex flex-col gap-2">
                          <div>{t('define-instructions-for-ai-to-edit-your-notes')}</div>
                        </div>
                      }
                    >
                      <Icon icon="proicons:info" width="18" height="18" />
                    </Tooltip>
                  </div>
                  <div><Button size="sm" color="warning" className="ml-2">{t('function-call-required')}</Button></div>
                </div>
              }
              rightContent={
                <Textarea
                  radius="lg"
                  value={aiSmartEditPrompt}
                  onBlur={(e) => {
                    updateConfig('aiSmartEditPrompt', e.target.value);
                  }}
                  onChange={(e) => {
                    if (!aiSmartEditPrompt) {
                      setAiSmartEditPrompt(e.target.value);
                    } else {
                      setAiSmartEditPrompt(e.target.value);
                    }
                  }}
                  className="w-full"
                />
              }
            />
          )}

          {aiPostProcessingMode === 'custom' && (
            <Item
              type={isPc ? 'row' : 'col'}
              leftContent={
                <div className="flex flex-col gap-1">
                  <div>{t('custom-ai-prompt')}</div>
                  <div className="text-[12px] text-default-400">
                    {t('available-variables')}:
                    <Button
                      size="sm"
                      variant="flat"
                      className="ml-2"
                      onPress={() => {
                        setAiCustomPrompt((prev) => (prev || '') + ' {tags}');
                      }}
                    >
                      {'{tags}'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      className="ml-2"
                      onPress={() => {
                        setAiCustomPrompt((prev) => (prev || '') + ' {note}');
                      }}
                    >
                      {'{note}'}
                    </Button>
                  </div>
                </div>
              }
              rightContent={
                <Textarea
                  id="custom-ai-prompt"
                  radius="lg"
                  minRows={4}
                  maxRows={8}
                  value={aiCustomPrompt || 'Analyze the note content and provide feedback. Use the available tools to implement your suggestions. Available tags: {tags}'}
                  onChange={(e) => {
                    setAiCustomPrompt(e.target.value);
                  }}
                  onBlur={(e) => {
                    updateConfig('aiCustomPrompt', e.target.value);
                  }}
                  className="w-full md:w-[400px]"
                  placeholder={t('enter-custom-prompt')}
                />
              }
            />
          )}
        </>
      )}
    </CollapsibleCard>
  );
});
