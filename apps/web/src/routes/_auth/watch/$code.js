import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Button } from "@golive/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Loader2, Maximize, Minimize, Radio, Users, Volume2, VolumeX, Wifi, } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTransmission } from "@/lib/transmissions";
import { startViewing } from "@/lib/viewer";
export const Route = createFileRoute("/_auth/watch/$code")({
    component: RouteComponent,
});
function RouteComponent() {
    const { code } = Route.useParams();
    const videoRef = useRef(null);
    const playerRef = useRef(null);
    const viewingRef = useRef(null);
    const [info, setInfo] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [status, setStatus] = useState("connecting");
    const [watchError, setWatchError] = useState(null);
    const [hasAudio, setHasAudio] = useState(false);
    const [muted, setMuted] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        getTransmission(code)
            .then(setInfo)
            .catch((error) => {
            setLoadError(error.message === "NotFound" ? "Room not found" : "Could not load this room");
        });
    }, [code]);
    useEffect(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        video.muted = true;
        viewingRef.current = startViewing({
            code,
            video,
            onStatus: setStatus,
            onStream: (stream) => {
                setHasAudio(Boolean(stream?.getAudioTracks().length));
                video.muted = true;
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
        video.play().catch(() => { });
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
        }
        else {
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
        return (_jsxs("div", { className: "container mx-auto max-w-3xl px-6 py-10 text-center", children: [_jsx("h1", { className: "text-xl font-bold", children: loadError }), _jsx("p", { className: "mt-2 text-sm text-muted-foreground", children: "Check the room code you were given and try again." })] }));
    }
    const isLive = status === "live";
    const isBusy = status === "connecting" || status === "reconnecting";
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-6", children: [_jsxs("header", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold tracking-tight md:text-2xl", children: info?.title ?? "Transmission" }), _jsxs("div", { className: "mt-1 flex items-center gap-2 text-sm text-muted-foreground", children: [_jsxs("span", { className: "font-mono", children: ["#", code] }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { className: "inline-flex items-center gap-1.5", children: [info?.host.image && (_jsx("img", { src: info.host.image, alt: "", className: "size-4 rounded-full", referrerPolicy: "no-referrer" })), info?.host.name ?? "the host"] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [isLive && (_jsxs("span", { className: "inline-flex h-7 items-center gap-1.5 border border-destructive/40 bg-destructive/15 px-2.5 text-xs font-semibold text-destructive", children: [_jsx(Radio, { className: "size-3.5 animate-pulse" }), "LIVE"] })), _jsxs(Button, { variant: "outline", onClick: copyLink, children: [copied ? _jsx(Check, { className: "size-4" }) : _jsx(Copy, { className: "size-4" }), copied ? "Copied" : "Share"] })] })] }), watchError && (_jsx("p", { className: "rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive", children: watchError })), _jsxs("div", { ref: playerRef, className: "group relative aspect-video w-full bg-black ring-1 ring-foreground/10", children: [_jsx("video", { ref: videoRef, muted: true, autoPlay: true, playsInline: true, className: "size-full object-contain" }), isBusy && (_jsxs("div", { className: "absolute inset-0 flex items-center justify-center gap-2 bg-black/60 text-muted-foreground", children: [_jsx(Loader2, { className: "size-6 animate-spin" }), _jsx("span", { className: "text-sm font-medium", children: status === "reconnecting" ? "Reconnecting…" : "Connecting…" })] })), status === "offline" && (_jsxs("div", { className: "absolute inset-0 flex flex-col items-center justify-center gap-3 border-0 bg-background p-6 text-center", children: [_jsx("div", { className: "flex size-12 items-center justify-center rounded-full border border-foreground/15 bg-muted/40", children: info?.host.image ? (_jsx("img", { src: info.host.image, alt: "", className: "size-12 rounded-full", referrerPolicy: "no-referrer" })) : (_jsx(Users, { className: "size-5" })) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold", children: "The stream is offline" }), _jsxs("p", { className: "mt-1 text-sm text-muted-foreground", children: [info?.host.name
                                                ? `${info.host.name} hasn't started yet. `
                                                : "The host hasn't started yet. ", "It will play here automatically the moment they go live."] })] }), _jsxs("span", { className: "inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground", children: [_jsx(Wifi, { className: "size-3.5" }), "Watching this room for changes\u2026"] })] })), isLive && (_jsxs(_Fragment, { children: [_jsxs("span", { className: "pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 border border-destructive/40 bg-destructive/20 px-2 py-0.5 text-xs font-semibold text-destructive backdrop-blur", children: [_jsx(Radio, { className: "size-3.5 animate-pulse" }), "LIVE"] }), muted && hasAudio && (_jsx("button", { type: "button", onClick: handleUnmute, className: "absolute inset-0 flex items-center justify-center bg-black/40", children: _jsxs("span", { className: "inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-black/90", children: [_jsx(VolumeX, { className: "size-4" }), "Click to unmute"] }) })), _jsxs("div", { className: "absolute bottom-0 right-0 flex items-center gap-1 p-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100", children: [_jsx(Button, { variant: "secondary", size: "icon", onClick: muted ? handleUnmute : handleMute, "aria-label": muted ? "Unmute" : "Mute", children: muted ? _jsx(VolumeX, { className: "size-4" }) : _jsx(Volume2, { className: "size-4" }) }), _jsx(Button, { variant: "secondary", size: "icon", onClick: toggleFullscreen, "aria-label": isFullscreen ? "Exit fullscreen" : "Fullscreen", children: isFullscreen ? _jsx(Minimize, { className: "size-4" }) : _jsx(Maximize, { className: "size-4" }) })] })] }))] }), _jsx("footer", { className: "text-sm text-muted-foreground", children: isLive ? (_jsxs("p", { children: ["Watching", " ", _jsx("strong", { className: "font-semibold text-foreground", children: info?.title ?? "this stream" }), " ", "with", info?.host.image && (_jsx("img", { src: info.host.image, alt: "", className: "mx-1 inline size-4 rounded-full", referrerPolicy: "no-referrer" })), info?.host.name ?? "the host", ". Share room ", _jsxs("span", { className: "font-mono", children: ["#", code] }), " ", "to invite more people."] })) : (_jsxs("p", { children: ["This room stays open \u2014 new viewers can join any time. Share room", " ", _jsxs("span", { className: "font-mono", children: ["#", code] }), " to invite more people."] })) })] }));
}
