import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem
} from "@heroui/dropdown";
import { Button } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';

const fonts = [
  { fontname: "default", displayName: "Default (System)" },
  { fontname: "DM Sans", displayName: "DM Sans" },
  { fontname: "Figtree", displayName: "Figtree" },
  { fontname: "Inter", displayName: "Inter" },
  { fontname: "Josefin Sans", displayName: "Josefin Sans" },
  { fontname: "Lato", displayName: "Lato" },
  { fontname: "Nunito", displayName: "Nunito" },
  { fontname: "Open Sans", displayName: "Open Sans" },
  { fontname: "Poppins", displayName: "Poppins" },
  { fontname: "Raleway", displayName: "Raleway" },
  { fontname: "Roboto", displayName: "Roboto" },
  { fontname: "Rubik", displayName: "Rubik" },
  { fontname: "Ubuntu", displayName: "Ubuntu" },
];



interface FontSwitcherProps{
    fontname?: string;
    onChange?: (fontname: string) => void;
}

const FontSwitcher = ({fontname = fonts[0]?.fontname, onChange} : FontSwitcherProps = {}) => {

    return (
      <Dropdown>
        <DropdownTrigger>
          <Button variant="flat">
            {fonts.find(i => i.fontname === fontname)?.displayName || fontname}
          </Button>
        </DropdownTrigger>

        <DropdownMenu className="p-2 space-y-1">
          {fonts.map((font) => (
            <DropdownItem
              key={font.fontname}
              className="flex item-center justify-between cursor-pointer"
              onClick={() => {
                onChange?.(font.fontname);
              }}
            >
              <span className="flex items-center justify-between" style={{ fontFamily: font.fontname === 'default' ? undefined : font.fontname }}>
                {font.displayName}
                {fontname === font.fontname && <Icon icon="mingcute:check-fill" width="18" height="18" />}
              </span>
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
    )
}

export default FontSwitcher;