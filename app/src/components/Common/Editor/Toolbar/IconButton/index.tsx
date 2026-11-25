import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from "@heroui/react";
import { motion } from "motion/react";
import { observer } from "mobx-react-lite";
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from 'usehooks-ts';

export const IconButton = observer(({ tooltip, icon, onClick, classNames, children, size = 20, containerSize }: {
  tooltip: string | React.ReactNode,
  icon: string | any,
  onClick?: (e) => void,
  classNames?: {
    base?: string,
    icon?: string,
  },
  children?: any,
  size?: number,
  containerSize?: number
}) => {
  const { t } = useTranslation()
  const isPc = useMediaQuery('(min-width: 768px)')
  // iOS HIG: 44×44pt minimum tap target on touch screens; keep the compact size on desktop
  const hitSize = containerSize || (isPc ? size + 3 : 44)
  const iconSize = isPc ? size : Math.max(size, 22)
  return (
    <Tooltip content={typeof tooltip == 'string' ? t(tooltip) : tooltip} placement="bottom" delay={300}>
      <motion.div
        whileTap={{ y: 1 }}
        className={`hover:bg-hover !transition-all duration-200 cursor-pointer rounded-md flex items-center justify-center ${classNames?.base}`}
        style={{
          width: hitSize,
          height: hitSize
        }}
        onClick={e => {
          onClick?.(e)
        }}
      >
        {typeof icon === 'string' && icon.includes('svg') ? (
          <div dangerouslySetInnerHTML={{ __html: icon }} className={`w-[${iconSize}px] h-[${iconSize}px] flex items-center justify-center ${classNames?.icon}`} />
        ) : (
          <Icon icon={icon} className={classNames?.icon} width={iconSize} height={iconSize} />
        )}
        {children}
      </motion.div>
    </Tooltip>
  )
})