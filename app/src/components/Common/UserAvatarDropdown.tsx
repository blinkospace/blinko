import { Icon } from '@/components/Common/Iconify/icons';
import { Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Image } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { BaseStore } from '@/store/baseStore';
import { UserStore } from '@/store/user';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { signOut, navigate } from '../Auth/auth-client';
import { getBlinkoFileUrl } from '@/lib/blinkoEndpoint';

interface UserAvatarDropdownProps {
  onItemClick?: () => void;
  collapsed?: boolean;
  showOverlay?: boolean;
}

export const UserAvatarDropdown = observer(({ onItemClick, collapsed = false, showOverlay = false }: UserAvatarDropdownProps) => {
  const base = RootStore.Get(BaseStore);
  const user = RootStore.Get(UserStore);
  const { t } = useTranslation();
  const navigate = useNavigate()
  return (
    <Dropdown
      classNames={{
        content: 'bg-secondbackground',
      }}
    >
      <DropdownTrigger>
        <div className={`cursor-pointer ${collapsed ? 'flex justify-center' : 'flex items-center gap-2'}`}>
          <div className="relative group">
            {user.image ? (
              <img src={getBlinkoFileUrl(user.image, { token: user.tokenData.value?.token })} alt="avatar" className={`${collapsed ? 'w-10 h-10' : 'w-8 h-8'} rounded-full object-cover transition-all`} />
            ) : (
              <Image src="/logo.png" width={30} />
            )}
            <div className={`absolute inset-0 bg-black/30 rounded-full flex items-center justify-center transition-opacity ${showOverlay ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <Icon icon="mdi:cog" width="16" height="16" className="text-white" />
            </div>
          </div>
          {!collapsed && <span className="font-bold">{user.nickname || user.name}</span>}
        </div>
      </DropdownTrigger>
      <DropdownMenu aria-label="User Actions">
        <>
          {base.routerList
            .filter((i) => i.hiddenSidebar)
            .map((i) => (
              <DropdownItem
                key={i.title}
                className='font-bold'
                startContent={<Icon icon={i.icon} width="20" height="20" />}
                onPress={() => {
                  navigate(i.href);
                  base.currentRouter = i;
                  onItemClick?.();
                }}
              >
                {t(i.title)}
              </DropdownItem>
            ))}

          <DropdownItem
            key="logout"
            className="font-bold text-danger"
            startContent={<Icon icon="hugeicons:logout-05" width="20" height="20" />}
            onPress={async () => {
              await signOut({ callbackUrl: '/signin', redirect: false });
              navigate('/signin');
              onItemClick?.();
            }}
          >
            {t('logout')}
          </DropdownItem>
        </>
      </DropdownMenu>
    </Dropdown>
  );
});
