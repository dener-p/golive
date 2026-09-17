import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@golive/ui/components/card";
import { Button } from "@golive/ui/components/button";
import { Input } from "@golive/ui/components/input";
import { Label } from "@golive/ui/components/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MonitorPlay, Radio } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { createTransmission } from "@/lib/transmissions";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/_auth/live")({
  component: RouteComponent,
});

function RouteComponent() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const { t } = useI18n();

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const room = await createTransmission(title);
      navigate({
        to: "/stream/$code",
        params: { code: room.code },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("createTransmissionFailed"));
      setIsCreating(false);
    }
  };

  const handleJoin = () => {
    const code = roomCode.trim().toLowerCase();
    if (!code) {
      return;
    }
    navigate({
      to: "/watch/$code",
      params: { code },
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("welcomeBack")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("welcomeBackDesc", { name: session.data?.user.name ?? "" })}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <Radio className="size-4" />
            </div>
            <CardTitle>{t("startATransmission")}</CardTitle>
          </CardHeader>
          <CardDescription>
            <div className="px-(--card-spacing) text-xs/relaxed text-muted-foreground">
              {t("startATransmissionDesc")}
            </div>
          </CardDescription>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="title">{t("titleLabel")}</Label>
              <Input
                id="title"
                value={title}
                placeholder={t("titlePlaceholder")}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleCreate} disabled={isCreating} className="w-full gap-2">
              <Radio className="size-4" />
              {isCreating ? t("creating") : t("createRoomAndOpenStudio")}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <MonitorPlay className="size-4" />
            </div>
            <CardTitle>{t("watchAStream")}</CardTitle>
          </CardHeader>
          <CardDescription>
            <div className="px-(--card-spacing) text-xs/relaxed text-muted-foreground">
              {t("watchAStreamDesc")}
            </div>
          </CardDescription>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="room-code">{t("roomCode")}</Label>
              <div className="flex gap-2">
                <Input
                  id="room-code"
                  value={roomCode}
                  placeholder={t("roomCodePlaceholder")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setRoomCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleJoin();
                    }
                  }}
                />
                <Button onClick={handleJoin} disabled={!roomCode.trim()} className="shrink-0">
                  {t("join")}
                </Button>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">{t("roomCodeHint")}</p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
