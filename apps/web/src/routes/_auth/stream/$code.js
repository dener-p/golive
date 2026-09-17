import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Button } from "@golive/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Loader2, MonitorPlay, Radio, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { startBroadcast } from "@/lib/broadcast";
import { STREAM_QUALITIES, STREAM_QUALITY_ORDER, } from "@/lib/quality";
import { getTransmission } from "@/lib/transmissions";
export const Route = createFileRoute("/_auth/stream/$code")({
    component: RouteComponent,
});
function RouteComponent() {
    const { code } = Route.useParams();
    const { session } = Route.useRouteContext();
    const previewRef = useRef(null);
    const broadcastRef = useRef(null);
    const streamRef = useRef(null);
    const [info, setInfo] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [isLive, setIsLive] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [viewerCount, setViewerCount] = useState(0);
    const [quality, setQuality] = useState("high");
    const [liveError, setLiveError] = useState(null);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        getTransmission(code)
            .then(setInfo)
            .catch((error) => {
            setLoadError(error.message === "NotFound" ? "Room not found" : "Could not load this room");
        });
    }, [code]);
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
                previewRef.current.play().catch(() => { });
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
        }
        catch (error) {
            setIsStarting(false);
            setLiveError(error instanceof DOMException && error.name === "NotAllowedError"
                ? "Screen sharing was cancelled"
                : error instanceof Error
                    ? error.message
                    : "Could not start screen sharing");
        }
    };
    const copyLink = useCallback(async () => {
        await navigator.clipboard.writeText(`${window.location.origin}/watch/${code}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [code]);
    if (loadError) {
        return (_jsxs("div", { className: "container mx-auto max-w-3xl px-6 py-10 text-center", children: [_jsx("h1", { className: "text-xl font-bold", children: loadError }), _jsx("p", { className: "mt-2 text-sm text-muted-foreground", children: "Check the room code you were given and try again." })] }));
    }
    if (info && session.data?.user.id !== info.hostUserId) {
        return (_jsxs("div", { className: "container mx-auto max-w-3xl px-6 py-10 text-center", children: [_jsx("h1", { className: "text-xl font-bold", children: "You're not the host of this room" }), _jsx(Button, { render: _jsx("a", { href: `/watch/${code}` }), nativeButton: false, className: "mt-4", children: "Watch it instead" })] }));
    }
    const watchUrl = `${window.location.origin}/watch/${code}`;
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-6", children: [_jsxs("header", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold tracking-tight md:text-2xl", children: info?.title ?? "Transmission" }), _jsxs("div", { className: "mt-1 flex items-center gap-2 text-sm text-muted-foreground", children: [_jsxs("span", { className: "font-mono", children: ["#", code] }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsx("span", { children: "Broadcast studio" })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [isLive && (_jsxs("span", { className: "inline-flex h-7 items-center gap-1.5 border border-destructive/40 bg-destructive/15 px-2.5 text-xs font-semibold text-destructive", children: [_jsx(Radio, { className: "size-3.5 animate-pulse" }), "LIVE \u00B7 ", viewerCount, " ", viewerCount === 1 ? "viewer" : "viewers"] })), _jsxs(Button, { variant: "outline", onClick: copyLink, children: [copied ? _jsx(Check, { className: "size-4" }) : _jsx(Copy, { className: "size-4" }), copied ? "Copied" : "Copy link"] }), isLive ? (_jsx(Button, { variant: "destructive", onClick: stopLive, children: "End stream" })) : (_jsxs(Button, { onClick: goLive, disabled: isStarting, children: [isStarting ? (_jsx(Loader2, { className: "size-4 animate-spin" })) : (_jsx(Radio, { className: "size-4" })), isStarting ? "Waiting for picker…" : "Go Live"] }))] })] }), liveError && (_jsx("p", { className: "rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive", children: liveError })), _jsxs("div", { className: "relative aspect-video w-full bg-black ring-1 ring-foreground/10", children: [_jsx("video", { ref: previewRef, muted: true, playsInline: true, className: "size-full object-contain" }), !isLive && (_jsxs("div", { className: "absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/95 p-6 text-center", children: [_jsx("div", { className: "flex size-12 items-center justify-center rounded-full border border-foreground/15 bg-muted/40", children: _jsx(MonitorPlay, { className: "size-5" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold", children: "Ready when you are" }), _jsxs("p", { className: "mx-auto mt-1 max-w-sm text-sm text-muted-foreground", children: ["Hit Go Live, pick a screen or window, and up to", " ", _jsxs("strong", { className: "text-foreground", children: [STREAM_QUALITIES[quality].width, "\u00D7", STREAM_QUALITIES[quality].height, " \u00B7", " ", STREAM_QUALITIES[quality].maxFramerate, "fps"] }), " ", "video will be sent to everyone in this room."] })] }), _jsxs("div", { className: "flex flex-col items-center gap-2", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "Stream quality" }), _jsx("div", { className: "flex items-center gap-0.5 border border-border bg-muted/40 p-0.5", children: STREAM_QUALITY_ORDER.map((streamQuality) => {
                                            const preset = STREAM_QUALITIES[streamQuality];
                                            const active = quality === streamQuality;
                                            return (_jsxs(Button, { type: "button", size: "sm", variant: active ? "secondary" : "ghost", disabled: isStarting, onClick: () => setQuality(streamQuality), className: "gap-1.5", children: [_jsx("span", { className: "font-semibold", children: preset.label }), _jsx("span", { className: active ? "text-secondary-foreground/70" : "text-muted-foreground", children: preset.description })] }, streamQuality));
                                        }) })] }), _jsxs(Button, { onClick: goLive, disabled: isStarting, className: "gap-2", children: [isStarting ? (_jsx(Loader2, { className: "size-4 animate-spin" })) : (_jsx(Radio, { className: "size-4" })), isStarting ? "Waiting for picker…" : "Go Live"] }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Share ", _jsx("span", { className: "font-mono", children: watchUrl })] })] })), isLive && (_jsxs(_Fragment, { children: [_jsxs("span", { className: "pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 border border-destructive/40 bg-destructive/20 px-2 py-0.5 text-xs font-semibold text-destructive backdrop-blur", children: [_jsx(Radio, { className: "size-3.5 animate-pulse" }), "LIVE"] }), _jsxs("span", { className: "pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-foreground/80 backdrop-blur", children: [_jsx(Users, { className: "size-3.5" }), viewerCount, " ", viewerCount === 1 ? "viewer" : "viewers"] })] }))] }), _jsx("footer", { className: "text-sm text-muted-foreground", children: isLive ? (_jsxs("p", { children: ["You're broadcasting to everyone in room ", _jsxs("span", { className: "font-mono", children: ["#", code] }), ". Ending the stream (or closing the share picker) stops it for all viewers."] })) : (_jsx("p", { children: "The room is ready. Viewers who open your link will wait here and your stream will play automatically the moment you go live." })) })] }));
}
