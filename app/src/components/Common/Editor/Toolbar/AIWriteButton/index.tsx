import { IconButton } from '../IconButton';
import { useTranslation } from 'react-i18next';
import { EditorStore } from '../../editorStore';
import { Input, Button } from '@heroui/react';
import { Popover, PopoverContent, PopoverTrigger } from '@heroui/react';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { BlinkoStore } from '@/store/blinkoStore';
import { RootStore } from '@/store/root';
import { AiStore } from '@/store/aiStore';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { Icon } from '@/components/Common/Iconify/icons';
import { SendIcon } from '@/components/Common/Icons';
import { MarkdownRender } from '@/components/Common/MarkdownRender';
import { PluginApiStore } from '@/store/plugin/pluginApiStore';

export const AIWriteButton = observer(({ store }: { store: EditorStore }) => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore);
  const ai = RootStore.Get(AiStore);
  const scrollRef = useRef<any>(null);
  const pluginApi = RootStore.Get(PluginApiStore);

  const localStore = RootStore.Local(() => ({
    show: false,
    setShow: (show: boolean) => {
      localStore.show = show;
    },

    async handleSubmit() {
      if (!ai.writeQuestion.trim()) return;
      try {
        ai.writeStream('custom', blinko.isCreateMode ? blinko.noteContent : blinko.curSelectedNote!.content);
      } catch (error) {
        console.error('error:', error);
      }
    }
  }));

  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [ai.writingResponseText]);

  return (
    <Popover
      placement="bottom-start"
      isOpen={localStore.show}
      onOpenChange={localStore.setShow}
      shouldCloseOnBlur={false}
    >
      <PopoverTrigger>
        <div onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          localStore.setShow(true);
        }}>
          <IconButton
            tooltip={t('ai-write')}
            icon="hugeicons:quill-write-01"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent className='flex flex-col p-3 bg-background md:max-w-[500px] max-w-[full]'>
        <div className="flex flex-col gap-3 w-full">
          <div className="flex gap-2 items-center">
            <Input
              className='border-none'
              value={ai.writeQuestion}
              onChange={(e) => ai.writeQuestion = e.target.value}
              placeholder={'Prompt...'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  localStore.handleSubmit();
                }
              }}
              startContent={<Icon className='text-primary' icon="hugeicons:ai-beautify" width="16" height="16" />}
              endContent={
                ai.isLoading ?
                  <Icon icon="mingcute:loading-line" width="16" height="16" /> :
                  <SendIcon onClick={localStore.handleSubmit} className='cursor-pointer primary-foreground group-hover:rotate-[-35deg] !transition-all' />
              }
            />

          </div>

          <div className='flex flex-wrap gap-2'>
            {pluginApi.customAiPrompts.map((prompt, index) => (
              <Button
                key={index}
                startContent={prompt.icon && <Icon icon={prompt.icon} width="16" height="16" />}
                variant='flat'
                color='warning'
                size='sm'
                onPress={() => {
                  ai.writeQuestion = prompt.prompt;
                  localStore.handleSubmit();
                }}
              >
                {prompt.name}
              </Button>
            ))}
          </div>

          {ai.writingResponseText && (
            <ScrollArea ref={scrollRef} className='p-2 max-h-[400px] max-w-full w-full max-w-full' onBottom={() => { }}>
              {ai.isLoading ?
                <div className='text-sm'>{ai.writingResponseText}</div> :
                <MarkdownRender content={ai.writingResponseText} />
              }
            </ScrollArea>
          )}

          {ai.isWriting && (
            <div className='flex gap-2 items-center'>
              <Button onPress={() => {
                ai.isWriting = false;
                // Write into the editor this toolbar belongs to. Emitting on the global
                // eventBus reached every mounted editor (including hidden ones such as
                // the home composer), so the text could land in the wrong note.
                if (ai.currentWriteType == 'polish') {
                  store.replaceMarkdown(ai.writingResponseText);
                } else {
                  store.insertMarkdown(ai.writingResponseText);
                }
                ai.writingResponseText = '';
                localStore.setShow(false);
              }} startContent={<Icon icon="ic:sharp-check" className='green' />}
                size='sm' variant='light' color='success'>{t('accept')}</Button>

              <Button onPress={() => {
                ai.isWriting = false;
                ai.writingResponseText = '';
                localStore.setShow(false);
              }} startContent={<Icon icon="ic:sharp-close" className='red' />}
                size='sm' variant='light' color='danger'>{t('reject')}</Button>

              <Button onPress={() => {
                ai.abortAiWrite();
              }} startContent={<Icon icon="mynaui:stop" className='blinko' />}
                size='sm' variant='light' color='warning'>{t('stop')}</Button>
            </div>
          )}

          <div className='flex items-center gap-2'>
            <Button
              startContent={<Icon icon="proicons:text-expand" width="16" height="16" />}
              variant='flat'
              color='warning'
              size='sm'
              onPress={() => {
                ai.writeStream('expand', blinko.isCreateMode ? blinko.noteContent : blinko.curSelectedNote!.content);
              }}
            >
              {t('ai-expand')}
            </Button>

            <Button
              startContent={<Icon icon="lucide:scan-text" width="16" height="16" />}
              variant='flat'
              color='warning'
              size='sm'
              onPress={() => {
                ai.writeStream('polish', blinko.isCreateMode ? blinko.noteContent : blinko.curSelectedNote!.content);
              }}
            >
              {t('ai-polish')}
            </Button>


            <Button
              isIconOnly
              size="sm"
              variant="light"
              onPress={() => localStore.setShow(false)}
              className='ml-auto'
            >
              <Icon icon="material-symbols:close" width={16} height={16} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}); 