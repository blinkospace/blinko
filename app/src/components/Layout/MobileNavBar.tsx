import { Icon } from '@/components/Common/Iconify/icons';
import { observer } from "mobx-react-lite";
import { RootStore } from "@/store";
import { BaseStore } from "@/store/baseStore";
import { BlinkoStore } from "@/store/blinkoStore";
import { getMobileGlassStyle, SideBarItem } from "./index";
import { useTranslation } from "react-i18next";
import { useSwiper } from "@/lib/hooks";
import { motion } from "framer-motion";
import { Link, useLocation, useSearchParams } from 'react-router-dom';

interface MobileNavBarProps {
  onItemClick?: () => void;
}

export const MobileNavBar = observer(({ onItemClick }: MobileNavBarProps) => {
  const base = RootStore.Get(BaseStore);
  const { t } = useTranslation();
  const blinkoStore = RootStore.Get(BlinkoStore);
  const isVisible = useSwiper();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  if (blinkoStore.config.value?.isHiddenMobileBar) {
    return null;
  }

  const routerInfo = {
    pathname: location.pathname,
    searchParams
  };

  // Get all visible items for mobile, including those that might be hidden in sidebar
  // Make sure to include items even if they have hiddenSidebar=true but hiddenMobile=false
  const mobileItems = base.routerList.filter(i => !i.hiddenMobile);

  return (
    <motion.div
      className="blinko-bottom-bar flex w-full px-3 pb-1 pt-2 gap-1 bg-background block md:hidden overflow-hidden fixed bottom-0 z-50"
      animate={{ y: isVisible ? 0 : 100 }}
      transition={{
        type: "spring",
        damping: 25,
        stiffness: 300,
        mass: 0.8,
        bounce: 0.3
      }}
      style={{
        paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))',
        height: 'calc(49px + env(safe-area-inset-bottom))',
        minHeight: 'calc(49px + env(safe-area-inset-bottom))',
        ...getMobileGlassStyle(),
      }}
    >
      {mobileItems.map((i, index) => (
        <motion.div
          key={i.title}
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{
            type: "spring",
            damping: 20,
            stiffness: 400,
            delay: index * 0.1
          }}
          className="flex-1"
        >
          <Link
            className={`w-full h-full items-center justify-center flex !flex-col group ${SideBarItem} ${base.isSideBarActive(routerInfo, i) ? '!text-foreground' : '!text-desc'
              } transition-all duration-200 hover:scale-110 active:scale-95`}
            to={i.href}
            onClick={() => {
              base.currentRouter = i;
              onItemClick?.();
            }}
          >
            <motion.div
              whileTap={{ scale: 0.9 }}
              whileHover={{ scale: 1.1 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Icon className={`text-center`} icon={i.icon} width="28" height="28" />
            </motion.div>
          </Link>
        </motion.div>
      ))}
    </motion.div>
  );
});