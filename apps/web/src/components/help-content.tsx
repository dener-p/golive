import { Button } from "@golive/ui/components/button";
import { Link } from "@tanstack/react-router";
import { KeyRound, LifeBuoy, Router } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export default function HelpContent() {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:px-6">
      <header>
        <div className="mb-4 inline-flex items-center gap-2 border border-foreground/15 bg-muted/40 px-3 py-1 text-xs font-medium">
          <LifeBuoy className="size-3.5" />
          {t("help")}
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{t("helpTitle")}</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground md:text-lg">
          {t("helpIntro")}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4 border border-foreground/10 bg-card p-6">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="size-4" />
            </div>
            <h2 className="text-base font-semibold">{t("helpOption1Title")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("helpOption1Desc")}</p>
          <ol className="flex list-none flex-col gap-3 text-sm">
            {[t("helpStep1"), t("helpStep2"), t("helpStep3")].map((step, index) => (
              <li key={index} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-foreground/15 bg-muted/40 text-xs font-semibold">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div>
            <p className="text-sm font-semibold">{t("helpTestTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("helpTestDesc")}</p>
          </div>
          <Button
            render={<Link to="/settings" />}
            nativeButton={false}
            className="mt-auto w-full gap-2"
          >
            {t("helpSettingsButton")}
          </Button>
        </div>

        <div className="flex flex-col gap-4 border border-foreground/10 bg-card p-6">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Router className="size-4" />
            </div>
            <h2 className="text-base font-semibold">{t("helpOption2Title")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("helpOption2Desc")}</p>
          <p className="mt-auto text-sm text-muted-foreground">
            <a
              href="https://tailscale.com/download"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              tailscale.com/download
            </a>
          </p>
        </div>
      </div>

      <p className="rounded border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {t("helpNote")}
      </p>
    </div>
  );
}