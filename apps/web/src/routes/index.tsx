import { Button } from "@golive/ui/components/button";
import { Input } from "@golive/ui/components/input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MonitorPlay, Radio } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState("");
  const { t } = useI18n();

  const join = () => {
    const code = roomCode.trim().toLowerCase();
    if (code) {
      navigate({ to: "/watch/$code", params: { code } });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-10 px-4 py-12 md:px-6 md:py-16">
      <div className="max-w-2xl text-center">
        <div className="mb-4 inline-flex items-center gap-2 border border-foreground/15 bg-muted/40 px-3 py-1 text-xs font-medium">
          <span className="size-1.5 rounded-full bg-destructive animate-pulse" />
          {t("inviteOnly")}
        </div>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl">GoLive</h1>
        <p className="mt-4 text-base text-muted-foreground md:text-lg">{t("homeTagline")}</p>
      </div>

      <div className="grid w-full max-w-3xl gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3 border border-foreground/10 bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Radio className="size-4 text-primary" />
            {t("startStreaming")}
          </div>
          <p className="text-sm text-muted-foreground">{t("startStreamingDesc")}</p>
          <Button render={<Link to="/live" />} nativeButton={false} className="mt-2 w-full gap-2">
            <Radio className="size-4" />
            {t("goToStudio")}
          </Button>
        </div>

        <div className="flex flex-col gap-3 border border-foreground/10 bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <MonitorPlay className="size-4 text-primary" />
            {t("watchAStream")}
          </div>
          <p className="text-sm text-muted-foreground">{t("watchAStreamDesc")}</p>
          <div className="mt-2 flex gap-2">
            <Input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  join();
                }
              }}
              placeholder={t("roomCodePlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button onClick={join} disabled={!roomCode.trim()} className="shrink-0">
              {t("join")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
