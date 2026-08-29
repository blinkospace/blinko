import { observer } from "mobx-react-lite";
import {
  Button,
  Card,
  Switch,
  Input,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Popover,
  PopoverTrigger,
  PopoverContent,
  InputOtp,
  Avatar,
  AvatarGroup,
  Checkbox,
  Chip,
} from "@heroui/react";
import { today, getLocalTimeZone, parseDate } from "@internationalized/date";
import dayjs from "@/lib/dayjs";
import { useEffect } from "react";
import { Icon } from '@/components/Common/Iconify/icons';
import { Calendar } from "@heroui/react";
import { motion, AnimatePresence } from "framer-motion";
import { RootStore } from "@/store";
import { BlinkoStore } from "@/store/blinkoStore";
import { useTranslation } from "react-i18next";
import { DialogStore } from "@/store/module/Dialog";
import { Copy } from "../Common/Copy";
import { api } from "@/lib/trpc";
import { PublicUser } from "@shared/lib/types";
import { UserStore } from "@/store/user";
import { getBlinkoEndpoint } from "@/lib/blinkoEndpoint";


interface ShareDialogProps {
  defaultSettings: ShareSettings;
  shareUrl?: string;
}

export interface ShareSettings {
  expiryDate?: Date;
  password?: string;
  shareUrl?: string;
  isShare?: boolean;
  internalShareUserIds?: number[];
  canEdit?: boolean;
}

interface User {
  id: number;
  name: string;
  nickname: string;
  image: string;
  canEdit?: boolean;
}

const expiryOptions = [
  { key: "never", label: ("permanent-valid") },
  { key: "7days", label: ("7days-expiry") },
  { key: "30days", label: ("30days-expiry") },
  { key: "custom", label: ("custom-expiry") },
];

const generateRandomPassword = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const BlinkoShareDialog = observer(({ defaultSettings }: ShareDialogProps) => {
  const { t } = useTranslation();

  const store = RootStore.Local(() => ({
    settings: (() => {
      const initialPassword = defaultSettings.shareUrl ? defaultSettings.password : generateRandomPassword();
      return {
        ...defaultSettings,
        password: initialPassword
      };
    })(),
    expiryType: defaultSettings.expiryDate ? "custom" : "never",
    isPublic: defaultSettings.password ? false : true,
    isShare: defaultSettings.isShare ?? false,
    selectedTab: "public",
    shareUrl: defaultSettings?.shareUrl ?? '',
    isCalendarOpen: false,
    teamMembers: [] as PublicUser[],
    selectedUserIds: defaultSettings.internalShareUserIds || [] as number[],
    isLoadingUsers: false,
    canEdit: defaultSettings.canEdit ?? false,

    get selectedExpiryValue() {
      if (this.expiryType === "never") return t("permanent-valid");
      if (this.settings.expiryDate) {
        return dayjs(this.settings.expiryDate).format('YYYY-MM-DD');
      }
      return t("select-expiry-time");
    },

    setSettings(newSettings: Partial<ShareSettings>) {
      this.settings = { ...this.settings, ...newSettings };
    },

    setExpiryType(type: string) {
      this.expiryType = type;
    },

    setIsPublic(value: boolean) {
      this.isPublic = value;
    },

    setIsShare(value: boolean) {
      this.isShare = value;
    },

    setSelectedTab(tab: string) {
      this.selectedTab = tab;
    },

    setShareUrl(url: string) {
      this.shareUrl = url;
    },

    setIsCalendarOpen(value: boolean) {
      this.isCalendarOpen = value;
    },

    setTeamMembers(members: PublicUser[]) {
      this.teamMembers = members;
    },

    setSelectedUserIds(ids: number[]) {
      this.selectedUserIds = ids;
    },

    setIsLoadingUsers(value: boolean) {
      this.isLoadingUsers = value;
    },

    setCanEdit(value: boolean) {
      this.canEdit = value;
    },

    handleExpiryChange(type: string) {
      this.setExpiryType(type);
      if (type === "never") {
        this.setSettings({ expiryDate: undefined });
      } else if (type === "7days") {
        this.setSettings({
          expiryDate: dayjs().add(7, 'days').toDate()
        });
      } else if (type === "30days") {
        this.setSettings({
          expiryDate: dayjs().add(30, 'days').toDate()
        });
      } else {
        this.setSettings({
          expiryDate: this.settings.expiryDate || dayjs().add(1, 'day').toDate()
        });
        this.setIsCalendarOpen(true);
      }
    },

    handleUserToggle(userId: number) {
      const index = this.selectedUserIds.indexOf(userId);
      if (index !== -1) {
        this.setSelectedUserIds(this.selectedUserIds.filter(id => id !== userId));
      } else {
        this.setSelectedUserIds([...this.selectedUserIds, userId]);
      }
    },

    async handleCreateShare() {
      // Handle public sharing
      if (this.selectedTab === "public") {
        const res = await RootStore.Get(BlinkoStore).shareNote.call({
          id: RootStore.Get(BlinkoStore).curSelectedNote!.id!,
          isCancel: false,
          password: this.isPublic ? "" : this.settings.password,
          expireAt: this.settings.expiryDate
        });
        const blinkoEndpoint = getBlinkoEndpoint() ?? window.location.origin;
        this.setShareUrl(blinkoEndpoint + 'share/' + (res?.shareEncryptedUrl ?? '') + (this.isPublic ? '' : '?password=' + (this.settings.password ?? '')));
        this.setIsShare(true);
      }   
      // Handle internal sharing
      else if (this.selectedTab === "internal") {
        await RootStore.Get(BlinkoStore).internalShareNote.call({
          id: RootStore.Get(BlinkoStore).curSelectedNote!.id!,
          accountIds: this.selectedUserIds,
          isCancel: false,
          canEdit: this.canEdit
        });
        this.setIsShare(true);
      }
    },

    async handleCancelShare() {
      // Cancel public sharing
      if (this.selectedTab === "public") {
        await RootStore.Get(BlinkoStore).shareNote.call({
          id: RootStore.Get(BlinkoStore).curSelectedNote!.id!,
          isCancel: true,
        });
      }
      // Cancel internal sharing for selected users
      else if (this.selectedTab === "internal") {
        await RootStore.Get(BlinkoStore).internalShareNote.call({
          id: RootStore.Get(BlinkoStore).curSelectedNote!.id!,
          accountIds: this.selectedUserIds,
          isCancel: true
        });
      }

      this.setIsShare(false);
      RootStore.Get(DialogStore).close();
    },

    async loadTeamMembers() {
      this.setIsLoadingUsers(true);
      try {
        const users = await api.users.publicUserList.query();
        this.setTeamMembers(users.filter(user => user.id !== RootStore.Get(UserStore).userInfo.value?.id));
        const sharedUsers = await RootStore.Get(BlinkoStore).getInternalSharedUsers.call(
          RootStore.Get(BlinkoStore).curSelectedNote!.id!
        );
        console.log(sharedUsers, 'sharedUsers')
        if (sharedUsers) {
          this.setSelectedUserIds(sharedUsers.map(user => user.id));
          // Reflect existing edit permission so re-sharing doesn't silently reset it
          if (sharedUsers.length > 0) {
            this.setCanEdit(sharedUsers.some(user => user.canEdit));
          }
        }
      } catch (error) {
        this.setTeamMembers([]);
      } finally {
        this.setIsLoadingUsers(false);
      }
    }
  }));

  useEffect(() => {
    if (store.selectedTab === "internal") {
      store.loadTeamMembers();
    }
  }, [store.selectedTab]);

  return (
    <Card shadow="none" className="flex flex-col gap-2 p-2">
      <div className="w-full mb-2">
        <div className="flex p-1 gap-2">
          <Button
            variant={store.selectedTab === "public" ? "solid" : "light"}
            color={store.selectedTab === "public" ? "primary" : "default"}
            className={`py-2 px-4 font-medium text-sm flex items-center gap-2 rounded-lg transition-colors`}
            onPress={() => store.setSelectedTab("public")}
          >
            <Icon icon="mdi:public" width="20" height="20" />
            {t("public-share")}
          </Button>
          <Button
            variant={store.selectedTab === "internal" ? "solid" : "light"}
            color={store.selectedTab === "internal" ? "primary" : "default"}
            className={`py-2 px-4 font-medium text-sm flex items-center gap-2 rounded-lg transition-colors`}
            onPress={() => store.setSelectedTab("internal")}
          >
            <Icon icon="material-symbols:public-off" width="20" height="20" />
            {t("internal-share")}
          </Button>
        </div>
      </div>

      {store.selectedTab === "public" && (
        <div className="flex flex-col">
          <div className="flex flex-col gap-2 mt-4">
            <div className="flex items-center gap-2 ">
              <span className="text-default-700 font-medium">{t("expiry-time")}</span>
              <AnimatePresence mode="wait">
                {store.settings.expiryDate && (
                  <motion.div
                    className="ml-auto bg-[#FEF4D5] text-sm text-[#F68C06] px-2 py-1 rounded-full flex items-center gap-2"
                    initial={{ x: -20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: -20, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Icon icon="lets-icons:clock" className="text-[#F68C06]" width="20" height="20" />
                    {dayjs(store.settings.expiryDate).fromNow()}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="flex gap-2 mt-2">
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    size="lg"
                    variant="ghost"
                    className="flex-1 justify-start"
                    startContent={<Icon icon="solar:calendar-bold" className="text-default-500" width="20" height="20" />}
                  >
                    {store.selectedExpiryValue}
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  onAction={(key) => store.handleExpiryChange(key as string)}
                  selectedKeys={[store.expiryType]}
                >
                  {expiryOptions.map((option) => (
                    <DropdownItem key={option.key}>
                      {t(option.label)}
                    </DropdownItem>
                  ))}
                </DropdownMenu>
              </Dropdown>

              {store.expiryType === "custom" && (
                <Popover
                  isOpen={store.isCalendarOpen}
                  onOpenChange={store.setIsCalendarOpen}
                  placement="bottom-end"
                >
                  <PopoverTrigger>
                    <Button
                      size="lg"
                      startContent={<Icon icon="solar:calendar-mark-bold" className="text-default-500" width="20" height="20" />}
                    >
                      {store.settings.expiryDate ? dayjs(store.settings.expiryDate).format('YYYY-MM-DD') : t("select-date")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <div className="p-1 bg-content1">
                      <Calendar
                        minValue={today(getLocalTimeZone())}
                        value={store.settings.expiryDate ? parseDate(dayjs(store.settings.expiryDate).format('YYYY-MM-DD')) : today(getLocalTimeZone()).add({ days: 1 })}
                        onChange={(date) => {
                          if (date) {
                            store.setSettings({
                              expiryDate: new Date(date.toString())
                            });
                            store.setIsCalendarOpen(false);
                          }
                        }}
                      />
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 mt-4">
            <div className="flex items-center gap-2">
              <span className="text-default-700 font-medium">{t("access-password")}</span>
              <span className="text-default-400 text-sm">{t("protect-your-shared-content")}</span>
              <Switch
                className="ml-auto"
                size="sm"
                isSelected={!store.isPublic}
                onValueChange={(checked) => {
                  store.setIsPublic(!checked);
                  if (checked) {
                    store.setSettings({ password: generateRandomPassword() });
                  }
                }}
              />
            </div>
            <div className="flex w-full justify-center items-center">
              {!store.isPublic && (
                <InputOtp
                  size="lg"
                  length={6}
                  placeholder={t("set-access-password")}
                  value={store.settings.password}
                  onValueChange={(value) => store.setSettings({ password: value })}
                />
              )}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {
              store.shareUrl && (
                <motion.div
                  className="flex flex-col gap-2 mt-4"
                  initial={{ y: -20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -20, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-default-700 font-medium">{t("share-link")}</span>
                  </div>
                  <div className="flex gap-2 items-center">
                    <Input
                      value={store.shareUrl}
                      readOnly
                    />
                    <Copy content={store.shareUrl} size={24} />
                  </div>
                </motion.div>
              )
            }
          </AnimatePresence>
        </div>
      )}

      {store.selectedTab === "internal" && (
        <div className="flex flex-col gap-4 mt-4">
          <div className="flex flex-col gap-2">
            {store.isLoadingUsers ? (
              <div className="flex justify-center p-4">
                <Icon icon="line-md:loading-twotone-loop" className="text-primary" width="24" height="24" />
              </div>
            ) : (
              store.teamMembers.length === 0 ? (
                <div className="text-center text-default-400 p-4">
                  {t("no-team-members-found")}
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {store.teamMembers.map(user => (
                    <div key={user.id} className="cursor-pointer flex items-center p-2 hover:bg-default-100 rounded-md" onClick={() => store.handleUserToggle(user.id)}>
                      <Checkbox
                        isSelected={store.selectedUserIds.includes(user.id)}
                        onValueChange={() => store.handleUserToggle(user.id)}
                      />
                      <Avatar
                        key={user.id}
                        src={user.image ?? undefined}
                        name={user.nickname || user.name}
                      />
                      <div className="ml-3">
                        <p className="text-sm font-bold">{user.nickname.toUpperCase() || user.name.toUpperCase()}</p>
                      </div>
                      <Chip variant="bordered" color="warning" className="ml-auto">
                        {user.role}
                      </Chip>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {store.selectedUserIds.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-default-700 font-medium">{t("selected-users")}</span>
              <AvatarGroup max={5}>
                {store.teamMembers
                  .filter(user => store.selectedUserIds.includes(user.id))
                  .map(user => (
                    <Avatar
                      key={user.id}
                      src={user.image ?? undefined}
                      name={user.nickname || user.name}
                    />
                  ))
                }
              </AvatarGroup>
            </div>
          )}

          {store.selectedUserIds.length > 0 && (
            <div className="flex items-center justify-between p-3 bg-default-50 dark:bg-default-100/10 rounded-md">
              <div className="flex flex-col">
                <span className="text-default-700 font-medium">{t("allow-edit")}</span>
                <span className="text-xs text-default-400">{t("allow-edit-desc")}</span>
              </div>
              <Switch isSelected={store.canEdit} onValueChange={store.setCanEdit} />
            </div>
          )}
        </div>
      )}

      <div className="w-full flex items-end gap-4 mt-6">
        {
          store.isShare && (
            <Button variant="flat" className="w-full" onPress={store.handleCancelShare}>
              {t("cancel-share")}
            </Button>
          )
        }
        <Button color="primary" className="w-full" onPress={store.handleCreateShare}>
          {t("create-share")}
        </Button>
      </div>
    </Card>
  );
});
