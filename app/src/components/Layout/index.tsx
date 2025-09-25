import React, { useEffect, useState } from 'react';
import { Button, Badge } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { UserStore } from '@/store/user';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { useTranslation } from 'react-i18next';
import { BaseStore } from '@/store/baseStore';
import { ScrollArea } from '../Common/ScrollArea';
import { BlinkoRightClickMenu } from '@/components/BlinkoRightClickMenu';
import { useMediaQuery } from 'usehooks-ts';
import { push as Menu } from 'react-burger-menu';
import { eventBus } from '@/lib/event';
import AiWritePop from '../Common/PopoverFloat/aiWritePop';
import { Sidebar } from './Sidebar';
import { MobileNavBar } from './MobileNavBar';
import FilterPop from '../Common/PopoverFloat/filterPop';
import { api } from '@/lib/trpc';
import { showTipsDialog } from '../Common/TipsDialog';
import { DialogStandaloneStore } from '@/store/module/DialogStandalone';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { BarSearchInput } from './BarSearchInput';
import { BlinkoNotification } from '@/components/BlinkoNotification';
import { AiStore } from '@/store/aiStore';
import { useLocation, useSearchParams, Link } from 'react-router-dom';

export const SideBarItem = 'p-2 flex flex-row items-center cursor-pointer gap-2 hover:bg-hover rounded-xl !transition-all';

export const getFixedHeaderBackground = () => {
  if (document?.documentElement?.classList?.contains('dark')) {
    return '#00000080';
  }
  return '#ffffff80';
};

export const CommonLayout = observer(({ children, header }: { children?: React.ReactNode; header?: React.ReactNode }) => {
  const [isClient, setClient] = useState(false);
  const [isOpen, setisOpen] = useState(false);

  const isPc = useMediaQuery('(min-width: 768px)');
  const { t } = useTranslation();
  const user = RootStore.Get(UserStore);
  const blinkoStore = RootStore.Get(BlinkoStore);
  const base = RootStore.Get(BaseStore);
  const location = useLocation()
  const [searchParams] = useSearchParams()
  blinkoStore.use();
  user.use();
  base.useInitApp();


  useEffect(() => {
    if (isPc) setisOpen(false);
  }, [isPc]);

  useEffect(() => {
    setClient(true);
    eventBus.on('close-sidebar', () => {
      setisOpen(false);
    });
  }, []);


  if (!isClient) return <></>;

  if (
    location.pathname == '/signin' ||
    location.pathname == '/quicknote' ||
    location.pathname == '/quickai' ||
    location.pathname == '/quicktool' ||
    location.pathname == '/signup' ||
    location.pathname == '/api-doc' ||
    location.pathname.includes('/share') ||
    location.pathname == '/editor' ||
    location.pathname == '/oauth-callback' ||
    location.pathname.includes('/ai-share')
  ) {
    return <>{children}</>;
  }

  return (
    <div className={`flex w-full h-mobile-full overflow-x-hidden`} id="outer-container">
      <AiWritePop />

      <Menu style={{
        bmMenuWrap: {
          transition: 'all .3s'
        }
      }} disableAutoFocus onClose={() => setisOpen(false)} onOpen={setisOpen} isOpen={isOpen} pageWrapId={'page-wrap'} outerContainerId={'outer-container'}>
        <Sidebar onItemClick={() => setisOpen(false)} />
      </Menu>

      {isPc && <Sidebar />}

      <main
        id="page-wrap"
        style={{ width: isPc ? `calc(100% - ${base.sideBarWidth}px)` : '100%' }}
        className={`flex !transition-all duration-300 overflow-y-hidden w-full flex-col gap-y-1 bg-secondbackground`}
      >
        {/* nav bar  */}
        <header
          className="blinko-mobile-header relative flex md:h-16 md:min-h-16 h-14 min-h-14 items-center justify-between gap-2 px-2 md:px:4 pt-2 md:pb-2 overflow-hidden"
          style={!isPc ? {
            position: 'fixed',
            top: 0,
            borderRadius:'0 0 12px 12px',
            zIndex: 11,
            width: '100%',
            background: getFixedHeaderBackground(),
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)'
          } : undefined}
        >
          {/* <div className="hidden md:block absolute bottom-[20%] right-[5%] z-[0] h-[350px] w-[350px] overflow-hidden blur-3xl ">
            <div className="w-full h-[100%] bg-[#9936e6] opacity-20" style={{ clipPath: 'circle(50% at 50% 50%)' }} />
          </div> */}
          <div className="flex max-w-full items-center gap-2 md:p-2 w-full z-[1]">
            {!isPc && (
              <Button isIconOnly className="flex" size="sm" variant="light" onPress={() => setisOpen(!isOpen)}>
                <Icon className="text-default-500" height={24} icon="solar:hamburger-menu-outline" width={24} />
              </Button>
            )}
            <div className="flex flex-1 items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-[4px] h-[16px] bg-primary rounded-xl hidden md:block" />
                <div className="flex flex-row items-center gap-1">
                  <div className="font-black select-none">
                    {location.pathname == '/ai'
                      ? !!RootStore.Get(AiStore).currentConversation.value?.title
                        ? RootStore.Get(AiStore).currentConversation.value?.title
                        : t(base.currentTitle)
                      : t(base.currentTitle)}
                  </div>
                  {searchParams.get('path') != 'trash' ? (
                    <Icon
                      className="cursor-pointer hover:rotate-180 !transition-all hidden md:block"
                      onClick={() => {
                        blinkoStore.refreshData();
                        blinkoStore.updateTicker++;
                      }}
                      icon="fluent:arrow-sync-12-filled"
                      width="20"
                      height="20"
                    />
                  ) : (
                    <Icon
                      className="cursor-pointer !transition-all text-red-500"
                      onClick={() => {
                        showTipsDialog({
                          size: 'sm',
                          title: t('confirm-to-delete'),
                          content: t('this-operation-removes-the-associated-label-and-cannot-be-restored-please-confirm'),
                          onConfirm: async () => {
                            await RootStore.Get(ToastPlugin).promise(api.notes.clearRecycleBin.mutate(), {
                              loading: t('in-progress'),
                              success: <b>{t('your-changes-have-been-saved')}</b>,
                              error: <b>{t('operation-failed')}</b>,
                            });
                            blinkoStore.refreshData();
                            RootStore.Get(DialogStandaloneStore).close();
                          },
                        });
                      }}
                      icon="mingcute:delete-2-line"
                      width="20"
                      height="20"
                    />
                  )}
                </div>
                {!base.isOnline && (
                  <Badge color="warning" variant="flat" className="animate-pulse">
                    <div className="flex text-sm items-center gap-1 text-yellow-500">
                      <span>{t('offline-status')}</span>
                    </div>
                  </Badge>
                )}
              </div>
              <div className="flex items-center justify-center gap-2 md:gap-4 w-auto ">
                <BarSearchInput isPc={isPc} />
                <FilterPop />
                {!blinkoStore.config.value?.isCloseDailyReview && <Badge size="sm" className="shrink-0" content={blinkoStore.dailyReviewNoteList.value?.length} color="warning">
                  <Link to="/review">
                    <Button
                      as="a"
                      className="mt-[2px]"
                      isIconOnly
                      size="sm"
                      variant="light"
                    >
                      <Icon className="cursor-pointer text-default-600" icon="tabler:bulb" width="24" height="24" />
                    </Button>
                  </Link>
                </Badge>}
                <BlinkoNotification />
              </div>
            </div>
          </div>
          {header}
        </header>



        {/* backdrop  pt-6 -mt-6 to fix the editor tooltip position */}
        <ScrollArea onBottom={() => { }} className={`${isPc ? 'h-[calc(100%_-_70px)]' : 'h-full'} !overflow-y-auto overflow-x-hidden mt-[-4px]`}>
          <div className="relative flex h-full w-full flex-col rounded-medium layout-container">
            {children}
          </div>
        </ScrollArea>

        <MobileNavBar onItemClick={() => setisOpen(false)} />
        <BlinkoRightClickMenu />
      </main>
    </div>
  );
});
