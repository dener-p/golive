import { Button } from "@golive/ui/components/button";
import { Link } from "@tanstack/react-router";
import { LifeBuoy, Radio } from "lucide-react";

import { useI18n } from "@/lib/i18n";

import { LanguageToggle } from "./language-toggle";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  const { locale, t } = useI18n();

  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between px-4 md:px-6">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Radio className="size-4" />
          </span>
          GoLive
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            render={<Link to={locale === "pt-BR" ? "/ajuda" : "/help"} />}
            nativeButton={false}
            className="gap-1.5 px-2 text-sm"
          >
            <LifeBuoy className="size-4" />
            {t("help")}
          </Button>
          <ModeToggle />
          <LanguageToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
