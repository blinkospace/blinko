import { Card, Button } from "@heroui/react";
import { Icon } from '@/components/Common/Iconify/icons';
import { motion, AnimatePresence } from "motion/react";
import { useState, ReactNode, useEffect } from "react";

interface CollapsibleCardProps {
  icon: string;
  title: string | ReactNode;
  children: ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
}

const DECORATIVE_ICONS = [
  "uil:thunderstorm",
  "uil:bug",
  "uil:surprise",
  "uil:brightness-low",
  // "uil:kid",
  "uil:flask",
  "uil:confused",
  "uil:favorite",
  "uil:compact-disc"
];

const usedIcons: any = new Set<string>();

const RandomIcon = ({ className = "" }) => {
  const [icon, setIcon] = useState<any>("");

  useEffect(() => {
    const availableIcons = DECORATIVE_ICONS.filter(icon => !usedIcons.has(icon));

    if (availableIcons.length === 0) {
      usedIcons.clear();
    }

    const randomIcon = availableIcons[Math.floor(Math.random() * availableIcons.length)];
    usedIcons.add(randomIcon);
    setIcon(randomIcon);
  }, []);

  const randomRotate = Math.floor(Math.random() * 360);
  const randomSize = 30 + Math.floor(Math.random() * 30);

  return icon ? (
    <Icon
      icon={icon}
      className={`absolute transform rotate-${randomRotate} ${className}`}
      width={randomSize}
    />
  ) : null;
};

export const CollapsibleCard = ({
  icon,
  title,
  children,
  className = "",
  defaultCollapsed = false
}: CollapsibleCardProps) => {
  const storageKey = `blinko-card-collapsed-${typeof title === 'string' ? title : ''}`;

  const [isCollapsed, setIsCollapsed] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? JSON.parse(stored) : false;
  });

  const handleCollapse = (value: boolean) => {
    setIsCollapsed(value);
    localStorage.setItem(storageKey, JSON.stringify(value));
  };

  return (
    <Card shadow="none" className={`flex flex-col p-2 md:p-4 bg-background relative ${className}`}>
      <div className="absolute inset-0 overflow-hidden opacity-[0.03] pointer-events-none">
        <RandomIcon className="right-[10%] bottom-[20%]" />
        <RandomIcon className="left-[15%] top-[25%]" />
        <RandomIcon className="right-[30%] top-[15%]" />
        <RandomIcon className="left-[25%] bottom-[30%]" />
        <RandomIcon className="right-[45%] bottom-[15%]" />
        <RandomIcon className="left-[40%] top-[40%]" />
        <RandomIcon className="right-[20%] top-[35%]" />
        <RandomIcon className="left-[35%] bottom-[25%]" />
      </div>

      <div className='flex items-center justify-between mb-2'>
        <div className="flex items-center gap-2">
          <Icon icon={icon} width="20" height="20" />
          <div className="font-bold">{title}</div>
        </div>
        <Button
          size="sm"
          isIconOnly
          variant="flat"
          onPress={() => handleCollapse(!isCollapsed)}
        >
          <Icon
            icon={isCollapsed ? "tabler:chevron-down" : "tabler:chevron-up"}
            width="20"
            height="20"
            className="cursor-pointer hover:bg-default-100 rounded-full p-0.5 transition-transform"
          />
        </Button>
      </div>

      <AnimatePresence>
        {!isCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ 
              duration: 0.2,
              ease: [0.4, 0, 0.2, 1]
            }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}; 