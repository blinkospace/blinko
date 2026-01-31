import { Icon } from '@/components/Common/Iconify/icons';
import { Popover, PopoverContent, PopoverTrigger, Select, SelectItem, Button, Radio, RadioGroup } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { RootStore } from "@/store";
import { BlinkoStore } from "@/store/blinkoStore";
import { useState } from "react";
import { RangeCalendar } from "@heroui/react";
import { today, getLocalTimeZone } from "@internationalized/date";
import dayjs from "@/lib/dayjs";
import TagSelector from "@/components/Common/TagSelector";

export default function FilterPop() {
  const { t } = useTranslation();
  const blinkoStore = RootStore.Get(BlinkoStore);

  const [isOpen, setIsOpen] = useState(false);
  const [dateRange, setDateRange] = useState<{
    start: any;
    end: any;
  }>({
    start: null,
    end: null
  });
  const [focusedValue, setFocusedValue] = useState(today(getLocalTimeZone()));
  const [tagStatus, setTagStatus] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<string | null>(null);

  const conditions = [
    { label: t('has-link'), value: 'hasLink' },
    { label: t('has-file'), value: 'hasFile' },
    { label: t('public'), value: 'isShare' },
    { label: t('has-todo'), value: 'hasTodo' },
  ];

  const handleApplyFilter = () => {
    blinkoStore.noteListFilterConfig = {
      ...blinkoStore.noteListFilterConfig,
      startDate: dateRange.start ? new Date(dateRange.start.toString()) : null,
      endDate: dateRange.end ? new Date(dateRange.end.toString()) : null,
      tagId: selectedTag ? Number(selectedTag) : null,
      withoutTag: tagStatus === 'without',
      withFile: selectedCondition === 'hasFile',
      withLink: selectedCondition === 'hasLink',
      isShare: selectedCondition === 'isShare' ? true : false,
      hasTodo: selectedCondition === 'hasTodo',
      isArchived: null
    };
    blinkoStore.noteList.resetAndCall({});
    setIsOpen(false);
  };

  const handleReset = () => {
    setDateRange({ start: null, end: null });
    setTagStatus("all");
    setSelectedTag(null);
    setSelectedCondition(null);

    blinkoStore.noteListFilterConfig = {
      ...blinkoStore.noteListFilterConfig,
      startDate: null,
      endDate: null,
      tagId: null,
      withoutTag: false,
      withFile: false,
      withLink: false,
      isArchived: false,
      isShare: null,
      hasTodo: false
    };
    blinkoStore.noteList.resetAndCall({});
    setIsOpen(false);
  };

  return (
    <Popover placement="bottom-start" backdrop="blur" isOpen={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger>
        <Button isIconOnly size="sm" variant="light">
          <Icon className="cursor-pointer text-default-600" icon="tabler:filter-bolt" width="24" height="24" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="p-4 flex flex-col gap-4 min-w-[300px]">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <Icon icon="solar:sort-by-time-broken" width="24" height="24" />
              {t('time-range')}
            </div>
            <Popover placement="bottom" classNames={{
              content: [
                "p-0 bg-transparent border-none shadow-none",
              ],
            }}>
              <PopoverTrigger>
                <div className="flex items-center gap-2 bg-default-100 rounded-lg p-3">
                  <Icon icon="solar:calendar-bold" className="text-default-500" width="20" height="20" />
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {dateRange.start ? dayjs(new Date(dateRange.start.toString())).format('YYYY-MM-DD') : t('start-date')}
                    </span>
                    <span className="text-default-500">{t('to')}</span>
                    <span className="text-sm">
                      {dateRange.end ? dayjs(new Date(dateRange.end.toString())).format('YYYY-MM-DD') : t('end-date')}
                    </span>
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent>
                <div className="flex flex-col gap-2">
                  <RangeCalendar
                    className="bg-background"
                    value={dateRange.start && dateRange.end ? dateRange : undefined}
                    onChange={setDateRange}
                    focusedValue={focusedValue}
                    onFocusChange={setFocusedValue}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <Icon icon="fluent:tag-search-24-regular" width="20" height="20" />
              {t('tag-status')}
            </div>
            <Select
              value={tagStatus}
              onChange={(e) => setTagStatus(e.target.value)}
              className="w-full"
              defaultSelectedKeys={['all']}
              classNames={{
                trigger: "h-12",
              }}
              labelPlacement="outside"
              placeholder={t('select-tag-status')}
              renderValue={(items) => {
                const item = items[0];
                const getIcon = (value: string) => {
                  switch (value) {
                    case 'all':
                      return <Icon icon="solar:notes-bold" width="20" height="20" />;
                    case 'with':
                      return <Icon icon="lucide:tags" width="20" height="20" />;
                    case 'without':
                      return <Icon icon="majesticons:tag-off-line" width="20" height="20" />;
                    default:
                      return null;
                  }
                };
                return (
                  <div className="flex items-center gap-2">
                    {getIcon(item?.key as string)}
                    <span>{item?.textValue}</span>
                  </div>
                );
              }}
            >
              {[
                { key: 'all', label: t('all'), icon: <Icon icon="solar:notes-bold" width="20" height="20" /> },
                { key: 'with', label: t('with-tags'), icon: <Icon icon="lucide:tags" width="20" height="20" /> },
                { key: 'without', label: t('without-tags'), icon: <Icon icon="majesticons:tag-off-line" width="20" height="20" /> }
              ].map((item) => (
                <SelectItem key={item.key} textValue={item.label}>
                  <div className="flex gap-2 items-center">
                    {item.icon}
                    <span className="text-small">{item.label}</span>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>

          {tagStatus === "with" && (
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium flex items-center gap-2">
                <Icon icon="solar:tags-bold" width="20" height="20" />
                {t('select-tags')}
              </div>
              
              <TagSelector
                selectedTag={selectedTag}
                onSelectionChange={(key) => setSelectedTag(key)}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <Icon icon="material-symbols:conditions" width="20" height="20" />
              {t('additional-conditions')}
            </div>
            <RadioGroup
              value={selectedCondition || ""}
              onValueChange={setSelectedCondition}
            >
              <Radio value="">{t('no-condition')}</Radio>
              {conditions.map(condition => (
                <Radio key={condition.value} value={condition.value}>
                  {condition.label}
                </Radio>
              ))}
            </RadioGroup>
          </div>

          <div className="flex gap-2">
            <Button
              color="primary"
              onClick={handleApplyFilter}
              className="flex-1"
              startContent={<Icon icon="solar:filter-bold" width="20" height="20" />}
            >
              {t('apply-filter')}
            </Button>
            <Button
              variant="flat"
              onClick={handleReset}
              className="flex-1"
              startContent={<Icon icon="fluent:arrow-reset-20-filled" width="20" height="20" />}
            >
              {t('reset')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
} 