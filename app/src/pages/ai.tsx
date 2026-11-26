import { Button } from '@heroui/react';
import { useRef, useState, useEffect } from 'react';
import { AiInput } from '@/components/BlinkoAi/aiInput';
import { Icon } from '@/components/Common/Iconify/icons';
import { useMediaQuery } from 'usehooks-ts';
import { motion, AnimatePresence } from 'framer-motion';
import { AiStore } from '@/store/aiStore';
import { RootStore } from '@/store';
import { cn } from '@/lib/utils';
import { observer } from 'mobx-react-lite';
import { BlinkoChatBox } from '@/components/BlinkoAi/aiChatBox';
import { Watermark } from '@hirohe/react-watermark';
import { useTheme } from 'next-themes';
import { UserStore } from '@/store/user';
import { useTranslation } from 'react-i18next';
import { BaseStore } from '@/store/baseStore';
import i18n from '@/lib/i18n';
const AIPage = observer(() => {
  const [prompt, setPrompt] = useState('');
  const isPc = useMediaQuery('(min-width: 768px)');
  const userStore = RootStore.Get(UserStore)
  const { t } = useTranslation()
  const aiStore = RootStore.Get(AiStore)
  const baseStore = RootStore.Get(BaseStore)
  const InputBoxRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const [inputHeight, setInputHeight] = useState(0);
  useEffect(() => {
    if (!InputBoxRef.current) return;

    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        setInputHeight(entry.contentRect.height);
      }
    });

    observer.observe(InputBoxRef.current);

    return () => {
      observer.disconnect();
    };
  }, []);

  const buttons = [
    {
      label: t('writing'),
      icon: 'hugeicons:quill-write-02',
      color: '#0057FF',
      prompt: t('ai-prompt-writing')
    },
    {
      label: t('coding'),
      icon: 'solar:code-bold',
      color: '#FF9500',
      prompt: t('ai-prompt-coding')
    },
    {
      label: t('translation'),
      icon: 'hugeicons:message-translate',
      color: '#2FBC52',
      prompt: t('ai-prompt-translation', { lang: i18n.language })
    }
  ];

  const suggestionActions = [
    {
      prompt: t('ai-prompt-writing-content')
    },
    {
      prompt: t('ai-prompt-translation-content')
    },
    {
      prompt: t('ai-prompt-delete-content')
    },
    {
      prompt: t('ai-prompt-coding-content')
    }
  ]

  return (
    <div
      style={{
        height: '100%'
      }}
      className={`flex flex-col items-center ${aiStore.isChatting ? 'pt-0' : 'pt-[10vh] md:pt-[20vh]'} w-full gap-4 relative  md:h-[calc(100vh_-_80px)]`}>
      {!aiStore.isChatting ? (
        <div className="flex justify-center w-full">
          <motion.div
            initial={{ width: 0, scaleX: 0 }}
            animate={{ width: "auto", scaleX: 1 }}
            transition={{
              duration: 1.2,
              ease: [0.16, 0.77, 0.47, 0.97],
              scaleX: {
                type: "spring",
                stiffness: 150,
                damping: 15,
                mass: 0.5
              }
            }}
            className="text-3xl font-bold overflow-hidden whitespace-nowrap origin-left"
          >
            {t('welcome-to-blinko', { name: userStore.userInfo?.value?.nickName.toUpperCase() ?? userStore.userInfo?.value?.name.toUpperCase() })}!
          </motion.div>
        </div>
      ) : (
        <div className="w-full " style={{ height: `calc(100% - ${inputHeight}px)` }}>
          <BlinkoChatBox />
        </div>
      )}

      <motion.div
        ref={InputBoxRef}
        layout
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className={cn(
          "flex flex-col items-center",
          isPc ? "w-[90%]" : "w-[95%]",
          aiStore.isChatting ? "absolute bottom-2" : "mt-4"
        )}
      >
        <AnimatePresence>
          {!aiStore.isChatting && (
            <motion.div
              className="w-full md:w-[85%] flex items-center gap-2 mt-4 overflow-x-scroll scrollbar-hide my-3"
              initial={{ y: 0, opacity: 1 }}
              exit={{
                y: 150,
                opacity: 0,
                transition: {
                  type: "spring",
                  damping: 10,
                  stiffness: 100
                }
              }}
            >
              <div className="flex gap-2 px-4 w-full items-center justify-center">
                {buttons.map((button, index) => (
                  <Button
                    onPress={() => {
                      aiStore.newRoleChat(button.prompt)
                    }}
                    className='w-fit'
                    key={index}
                    variant='light'
                    startContent={<Icon className='min-w-[20px]' icon={button.icon} color={button.color} width="20" height="20" />}
                  >
                    {button.label}
                  </Button>
                ))}
                <Button isIconOnly variant='light' startContent={<Icon icon="icon-park-outline:more" className='min-w-[20px]' width="20" height="20" />} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AiInput className={aiStore.isChatting ? 'mt-0' : 'mt-2'} />

        <AnimatePresence>
          {RootStore.Get(AiStore).withTools.value && !aiStore.isChatting && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className='flex gap-2 mt-4 flex-col items-center'
            >
              {suggestionActions.map((action, index) => (
                <Button
                  size={isPc ? 'md' : 'sm'}
                  onPress={() => {
                    aiStore.newChatWithSuggestion(t(action.prompt))
                  }}
                  className='w-fit'
                  key={index}
                  radius='full'
                  variant='flat'
                >
                  {t(action.prompt)}
                </Button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

      </motion.div>
    </div>
  );
});

export default AIPage;
