import { observer } from 'mobx-react-lite';
import { BasicSetting } from '@/components/BlinkoSettings/BasicSetting';
import AiSetting from '@/components/BlinkoSettings/AiSetting/AiSetting';
import { PerferSetting } from '@/components/BlinkoSettings/PerferSetting';
import { TaskSetting } from '@/components/BlinkoSettings/TaskSetting';
import { ImportSetting } from '@/components/BlinkoSettings/ImportSetting';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { UserStore } from '@/store/user';
import { RootStore } from '@/store';
import { UserSetting } from '@/components/BlinkoSettings/UserSetting';
import { AboutSetting } from '@/components/BlinkoSettings/AboutSetting';
import { StorageSetting } from '@/components/BlinkoSettings/StorageSetting';
import { ExportSetting } from '@/components/BlinkoSettings/ExportSetting';
import { MusicSetting } from '@/components/BlinkoSettings/MusicSetting';
import { SSOSetting } from '@/components/BlinkoSettings/SSOSetting';
import { HttpProxySetting } from '@/components/BlinkoSettings/HttpProxySetting';
import { useTranslation } from 'react-i18next';
import { JSX } from 'react';
import { ScrollableTabs, TabItem } from '@/components/Common/ScrollableTabs';
import { useState, useEffect } from 'react';
import { BlinkoStore } from '@/store/blinkoStore';
import { PluginSetting } from '@/components/BlinkoSettings/PluginSetting';
import { ImportAIDialog } from '@/components/BlinkoSettings/ImportAIDialog';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { Icon } from '@/components/Common/Iconify/icons';
import { HotkeySetting } from '@/components/BlinkoSettings/HotkeySetting';
import { isDesktop } from '@/lib/tauriHelper';

type SettingItem = {
  key: string;
  title: string;
  icon: string;
  component: JSX.Element;
  requireAdmin: boolean;
  keywords?: string[];
};
export const allSettings: SettingItem[] = [
  {
    key: 'basic',
    title: ('basic-information'),
    icon: 'tabler:tool',
    component: <BasicSetting />,
    requireAdmin: false,
    keywords: ['basic', 'information', '基本信息', '基础设置'],
  },
  {
    key: 'prefer',
    title: ('preference'),
    icon: 'tabler:settings-2',
    component: <PerferSetting />,
    requireAdmin: false,
    keywords: ['preference', 'theme', 'language', '偏好设置', '主题', '语言'],
  },
  {
    key: 'hotkey',
    title: ('hotkeys'),
    icon: 'material-symbols:keyboard',
    component: <HotkeySetting />,
    requireAdmin: false,
    keywords: ['hotkey', 'shortcut', 'keyboard', 'desktop', '快捷键', '热键', '桌面'],
  },
  {
    key: 'user',
    title: ('user-list'),
    icon: 'tabler:users',
    component: <UserSetting />,
    requireAdmin: true,
    keywords: ['user', 'users', '用户', '用户列表'],
  },
  {
    key: 'ai',
    title: 'AI',
    icon: 'hugeicons:ai-beautify',
    component: <AiSetting />,
    requireAdmin: true,
    keywords: ['ai', 'artificial intelligence', '人工智能'],
  },
  {
    key: 'httpproxy',
    title: ('http-proxy'),
    icon: 'tabler:cloud-network',
    component: <HttpProxySetting />,
    requireAdmin: true,
    keywords: ['proxy', 'http', 'connection', '代理', 'HTTP代理'],
  },
  {
    key: 'task',
    title: ('schedule-task'),
    icon: 'tabler:list-check',
    component: <TaskSetting />,
    requireAdmin: true,
    keywords: ['task', 'schedule', '任务', '定时任务'],
  },
  {
    key: 'storage',
    title: ('storage'),
    icon: 'tabler:database',
    component: <StorageSetting />,
    requireAdmin: true,
    keywords: ['storage', 'database', '存储', '数据库'],
  },
  {
    key: 'music',
    title: ('music-settings'),
    icon: 'tabler:music',
    component: <MusicSetting />,
    requireAdmin: true,
    keywords: ['music', '音乐设置'],
  },
  {
    key: 'import',
    title: ('import'),
    icon: 'tabler:file-import',
    component: <ImportSetting />,
    requireAdmin: true,
    keywords: ['import', 'data', '导入', '数据导入'],
  },
  {
    key: 'sso',
    title: ('sso-settings'),
    icon: 'tabler:key',
    component: <SSOSetting />,
    requireAdmin: true,
    keywords: ['sso', 'single sign on', '单点登录'],
  },
  {
    key: 'export',
    title: ('export'),
    icon: 'tabler:file-export',
    component: <ExportSetting />,
    requireAdmin: false,
    keywords: ['export', 'data', '导出', '数据导出'],
  },
  {
    key: 'plugin',
    title: ('plugin-settings'),
    icon: 'hugeicons:plug-socket',
    component: <PluginSetting />,
    requireAdmin: true,
    keywords: ['plugin', 'plugins', '插件', '插件设置'],
  },
  {
    key: 'about',
    title: ('about'),
    icon: 'tabler:info-circle',
    component: <AboutSetting />,
    requireAdmin: false,
    keywords: ['about', 'information', '关于', '信息'],
  },
];
const Page = observer(() => {
  const user = RootStore.Get(UserStore);
  const blinkoStore = RootStore.Get(BlinkoStore);
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>('basic');
  const isMobile = useMediaQuery('(max-width: 768px)');

  const getVisibleSettings = () => {
    let settings = allSettings.filter((setting) => !setting.requireAdmin || user.isSuperAdmin);

    // Hide hotkey settings on mobile platforms
    settings = settings.filter((setting) =>
      (setting.key !== 'hotkey' || isDesktop())
    );

    if (blinkoStore.searchText) {
      const lowerSearchText = blinkoStore.searchText.toLowerCase();
      const filteredSettings = settings.filter((setting) =>
        setting.title.toLowerCase().includes(lowerSearchText) ||
        setting.keywords?.some((keyword) => keyword.toLowerCase().includes(lowerSearchText))
      );

      // If no settings match the search criteria, return all settings instead of an empty list
      if (filteredSettings.length === 0) {
        return settings;
      }

      return filteredSettings;
    }

    return settings;
  };

  const getCurrentComponent = () => {
    const setting = allSettings.find((s) => s.key === selected);
    return setting ? <div key={setting.key}>{setting.component}</div> : null;
  };

  const tabItems: TabItem[] = getVisibleSettings().map((setting) => ({
    key: setting.key,
    title: setting.title,
    icon: setting.icon,
  }));

  return (
    <div className="h-full flex flex-col">
      <ImportAIDialog onSelectTab={setSelected} />

      {isMobile ? (
        <div className="w-full">
          <div className="sticky top-0 z-10 w-full">
            <div className="mx-1 backdrop-blur-md bg-background rounded-2xl">
              {isMobile && <div className='h-16'></div>}
              <ScrollableTabs
                items={tabItems}
                selectedKey={selected}
                onSelectionChange={setSelected}
                color="primary"
              />
            </div>
          </div>
          <ScrollArea onBottom={() => { }} className="flex-1">
            <div className="max-w-[1024px] mx-auto flex flex-col gap-6 px-2 py-4">
              {getCurrentComponent()}
            </div>
          </ScrollArea>
        </div>
      ) : (
        <div className="w-full max-w-[1200px] mx-auto px-4 py-4 flex flex-row h-full">
          <div className="w-56 mr-6">
            <div className="rounded-xl bg-background p-1 mb-4">
              <ScrollArea onBottom={() => { }} className="h-auto max-h-[calc(100vh-140px)]">
                <div className="p-1 flex flex-col flex-nowrap gap-1">
                  {tabItems.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setSelected(item.key)}
                      className={`cursor-pointer flex items-center px-3 py-2 rounded-lg text-sm transition-colors ${selected === item.key
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'
                        }`}
                    >
                      {item.icon && (
                        <span className="flex-shrink-0 mr-2">
                          <Icon icon={item.icon} width="18" />
                        </span>
                      )}
                      <span className="font-bold">{typeof item.title === 'string' ? t(item.title) : item.title}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            <ScrollArea onBottom={() => { }} className="h-full">
              <div className="max-w-[900px] mx-auto flex flex-col gap-6">
                {getCurrentComponent()}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
});

export default Page;
