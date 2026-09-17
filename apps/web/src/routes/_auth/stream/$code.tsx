import { Button } from "@golive/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Loader2, MonitorPlay, Radio, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { startBroadcast, type BroadcastHandle } from "@/lib/broadcast";
import {
  STREAM_QUALITIES,
  STREAM_QUALITY_ORDER,
  type StreamQuality,
} from "@/lib/quality";
import { getTransmission, type TransmissionInfo } from "@/lib/transmissions";
import { useI18n, type MessageKey } from "@/lib/i18n";

export const Route = createFileRoute("/_auth/stream/$code")({
  component: RouteComponent,
});

function RouteComponent() {
  const { code } = Route.useParams();
  const { session } = Route.useRouteContext();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const broadcastRef = useRef<BroadcastHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const { t } = useI18n();

  const [info, setInfo] = useState<TransmissionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [quality, setQuality] = useState<StreamQuality>("high");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const qualityLabel: Record<StreamQuality, MessageKey> = {
    low: "qualityLow",
    medium: "qualityMedium",
    high: "qualityHigh",
  };

  useEffect(() => {
    getTransmission(code)
      .then(setInfo)
      .catch((error: Error) => {
        setLoadError(error.message === "NotFound" ? t("roomNotFound") : t("couldNotLoadRoom"));
      });
  }, [code, t]);

  const stopLive = useCallback(() => {
    broadcastRef.current?.stop();
    broadcastRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewRef.current) {
      previewRef.current.srcObject = null;
    }
    setViewerCount(0);
    setIsLive(false);
    setIsStarting(false);
  }, []);

  useEffect(() => {
    return () => {
      broadcastRef.current?.stop();
      broadcastRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const goLive = async () => {
    setLiveError(null);
    setIsStarting(true);
    try {
      const preset = STREAM_QUALITIES[quality];
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.maxFramerate, max: preset.maxFramerate },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      streamRef.current = media;
      if (previewRef.current) {
        previewRef.current.srcObject = media;
        previewRef.current.play().catch(() => {});
      }

      broadcastRef.current = startBroadcast({
        code,
        stream: media,
        quality,
        onViewerCount: setViewerCount,
        onError: setLiveError,
      });
      setIsLive(true);
      setIsStarting(false);

      media.getVideoTracks()[0]?.addEventListener("ended", stopLive, { once: true });
    } catch (error) {
      setIsStarting(false);
      setLiveError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? t("screenShareCancelled")
          : error instanceof Error
            ? error.message
            : t("couldNotStartScreenShare"),
      );
    }
  };

  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/watch/${code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  if (loadError) {
    return (
      <div className="container mx-auto max-w-3xl px-6 py-10 text-center">
        <h1 className="text-xl font-bold">{loadError}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("checkRoomCode")}</p>
      </div>
    );
  }

  if (info && session.data?.user.id !== info.hostUserId) {
    return (
      <div className="container mx-auto max-w-3xl px-6 py-10 text-center">
        <h1 className="text-xl font-bold">{t("notTheHost")}</h1>
        <Button render={<a href={`/watch/${code}`} />} nativeButton={false} className="mt-4">
          {t("watchInstead")}
        </Button>
      </div>
    );
  }

  const watchUrl = `${window.location.origin}/watch/${code}`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">
            {info?.title ?? t("transmission")}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">#{code}</span>
            <span aria-hidden>·</span>
            <span>{t("broadcastStudio")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive && (
            <span className="inline-flex h-7 items-center gap-1.5 border border-destructive/40 bg-destructive/15 px-2.5 text-xs font-semibold text-destructive">
              <Radio className="size-3.5 animate-pulse" />
              {t("live")} · {viewerCount} {viewerCount === 1 ? t("viewer") : t("viewers")}
            </span>
          )}
          <Button variant="outline" onClick={copyLink}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? t("copied") : t("copyLink")}
          </Button>
          {isLive ? (
            <Button variant="destructive" onClick={stopLive}>
              {t("endStream")}
            </Button>
          ) : (
            <Button onClick={goLive} disabled={isStarting}>
              {isStarting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Radio className="size-4" />
              )}
              {isStarting ? t("waitingForPicker") : t("goLive")}
            </Button>
          )}
        </div>
      </header>

      {liveError && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {liveError}
        </p>
      )}

      <div className="relative aspect-video w-full bg-black ring-1 ring-foreground/10">
        <video ref={previewRef} muted playsInline className="size-full object-contain" />

        {!isLive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/95 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-foreground/15 bg-muted/40">
              <MonitorPlay className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{t("readyWhenYouAre")}</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {t("goLivePickerDesc", {
                  res: `${STREAM_QUALITIES[quality].width}×${STREAM_QUALITIES[quality].height} · ${STREAM_QUALITIES[quality].maxFramerate}fps`,
                })}
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground">{t("streamQuality")}</p>
              <div className="flex items-center gap-0.5 border border-border bg-muted/40 p-0.5">
                {STREAM_QUALITY_ORDER.map((streamQuality) => {
                  const preset = STREAM_QUALITIES[streamQuality];
                  const active = quality === streamQuality;
                  return (
                    <Button
                      key={streamQuality}
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "ghost"}
                      disabled={isStarting}
                      onClick={() => setQuality(streamQuality)}
                      className="gap-1.5"
                    >
                      <span className="font-semibold">{t(qualityLabel[streamQuality])}</span>
                      <span
                        className={
                          active ? "text-secondary-foreground/70" : "text-muted-foreground"
                        }
                      >
                        {preset.description}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
            <Button onClick={goLive} disabled={isStarting} className="gap-2">
              {isStarting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Radio className="size-4" />
              )}
              {isStarting ? t("waitingForPicker") : t("goLive")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("shareUrl", { url: watchUrl })}
            </p>
          </div>
        )}

        {isLive && (
          <>
            <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 border border-destructive/40 bg-destructive/20 px-2 py-0.5 text-xs font-semibold text-destructive backdrop-blur">
              <Radio className="size-3.5 animate-pulse" />
              {t("live")}
            </span>
            <span className="pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-foreground/80 backdrop-blur">
              <Users className="size-3.5" />
              {viewerCount} {viewerCount === 1 ? t("viewer") : t("viewers")}
            </span>
          </>
        )}
      </div>

      <footer className="text-sm text-muted-foreground">
        {isLive ? (
          <p>{t("broadcastingFooter", { code })}</p>
        ) : (
          <p>{t("roomReadyFooter")}</p>
        )}
      </footer>
    </div>
  );
}
