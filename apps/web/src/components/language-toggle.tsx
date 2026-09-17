import { Button } from "@golive/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@golive/ui/components/dropdown-menu";
import { Languages } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" />}>
        <Languages className="size-4" />
        <span className="sr-only">{t("selectLanguage")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className={locale === "en" ? "font-semibold" : undefined}
          onClick={() => setLocale("en")}
        >
          English
        </DropdownMenuItem>
        <DropdownMenuItem
          className={locale === "pt-BR" ? "font-semibold" : undefined}
          onClick={() => setLocale("pt-BR")}
        >
          Português (Brasil)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}