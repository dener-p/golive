import { Button } from "@golive/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Loader2,
  Maximize,
  Minimize,
  Radio,
  Users,
  Volume2,
  VolumeX,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getTransmission, type TransmissionInfo } from "@/lib/transmissions";
import { startViewing, type ViewingHandle, type ViewingStatus } from "@/lib/viewer";

export const Route = createFileRoute("/_auth/watch/$code")({
  component: RouteComponent,
});

function RouteComponent() {
  const { code } = Route.useParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const viewingRef = useRef<ViewingHandle | null>(null);

  const [info, setInfo] = useState<TransmissionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewingStatus>("connecting");
  const [watchError, setWatchError] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [muted, setMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getTransmission(code)
      .then(setInfo)
      .catch((error: Error) => {
        setLoadError(error.message === "NotFound" ? "Room not found" : "Could not load this room");
      });
  }, [code]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.muted = true;
    viewingRef.current = startViewing({
      code,
      video: videoRef.current,
      onStatus: setStatus,
      onStream: (stream) => {
        setHasAudio(Boolean(stream?.getAudioTracks().length));
        videoRef.current!.muted = true;
        setMuted(true);
      },
      onError: setWatchError,
    });
    return () => {
      viewingRef.current?.stop();
      viewingRef.current = null;
    };
  }, [code]);

  const handleUnmute = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = false;
    video.play().catch(() => {});
    setMuted(false);
  }, []);

  const handleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = true;
    setMuted(true);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = playerRef.current;
    if (!container) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/watch/${code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  if (loadError) {
    return (
      <div className="container mx-auto max-w-3xl px-6 py-10 text-center">
        <h1 className="text-xl font-bold">{loadError}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Check the room code you were given and try again.
        </p>
      </div>
    );
  }

  const isLive = status === "live";
  const isBusy = status === "connecting" || status === "reconnecting";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">
            {info?.title ?? "Transmission"}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">#{code}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              {info?.host.image && (
                <img
                  src={info.host.image}
                  alt=""
                  className="size-4 rounded-full"
                  referrerPolicy="no-referrer"
                />
              )}
              {info?.host.name ?? "the host"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive && (
            <span className="inline-flex h-7 items-center gap-1.5 border border-destructive/40 bg-destructive/15 px-2.5 text-xs font-semibold text-destructive">
              <Radio className="size-3.5 animate-pulse" />
              LIVE
            </span>
          )}
          <Button variant="outline" onClick={copyLink}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Share"}
          </Button>
        </div>
      </header>

      {watchError && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {watchError}
        </p>
      )}

      <div
        ref={playerRef}
        className="group relative aspect-video w-full bg-black ring-1 ring-foreground/10"
      >
        <video ref={videoRef} muted autoPlay playsInline className="size-full object-contain" />

        {isBusy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-sm font-medium">
              {status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
            </span>
          </div>
        )}

        {status === "offline" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 border-0 bg-background p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-foreground/15 bg-muted/40">
              {info?.host.image ? (
                <img
                  src={info.host.image}
                  alt=""
                  className="size-12 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Users className="size-5" />
              )}
            </div>
            <div>
              <p className="text-sm font-semibold">The stream is offline</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {info?.host.name
                  ? `${info.host.name} hasn't started yet. `
                  : "The host hasn't started yet. "}
                It will play here automatically the moment they go live.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
              <Wifi className="size-3.5" />
              Watching this room for changes…
            </span>
          </div>
        )}

        {isLive && (
          <>
            <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 border border-destructive/40 bg-destructive/20 px-2 py-0.5 text-xs font-semibold text-destructive backdrop-blur">
              <Radio className="size-3.5 animate-pulse" />
              LIVE
            </span>

            {muted && hasAudio && (
              <button
                type="button"
                onClick={handleUnmute}
                className="absolute inset-0 flex items-center justify-center bg-black/40"
              >
                <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-black/90">
                  <VolumeX className="size-4" />
                  Click to unmute
                </span>
              </button>
            )}

            <div className="absolute bottom-0 right-0 flex items-center gap-1 p-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Button
                variant="secondary"
                size="icon"
                onClick={muted ? handleUnmute : handleMute}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </Button>
              <Button
                variant="secondary"
                size="icon"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
              </Button>
            </div>
          </>
        )}
      </div>

      <footer className="text-sm text-muted-foreground">
        {isLive ? (
          <p>
            Watching{" "}
            <strong className="font-semibold text-foreground">
              {info?.title ?? "this stream"}
            </strong>{" "}
            with
            {info?.host.image && (
              <img
                src={info.host.image}
                alt=""
                className="mx-1 inline size-4 rounded-full"
                referrerPolicy="no-referrer"
              />
            )}
            {info?.host.name ?? "the host"}. Share room <span className="font-mono">#{code}</span>{" "}
            to invite more people.
          </p>
        ) : (
          <p>
            This room stays open — new viewers can join any time. Share room{" "}
            <span className="font-mono">#{code}</span> to invite more people.
          </p>
        )}
      </footer>
    </div>
  );
}
