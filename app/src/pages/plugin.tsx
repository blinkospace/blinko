import { observer } from 'mobx-react-lite';
import { PluginSetting } from '@/components/BlinkoSettings/PluginSetting';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { useTranslation } from 'react-i18next';

const PluginPage = observer(() => {
  const { t } = useTranslation();
  
  return (
    <div className="h-full flex flex-col">
      <ScrollArea fixMobileTopBar reserveMobileBottomBar className="flex-1">
        <div className="w-full mx-auto flex flex-col gap-6 px-4 md:px-6 py-4">
          <PluginSetting />
        </div>
      </ScrollArea>
    </div>
  );
});

export default PluginPage;