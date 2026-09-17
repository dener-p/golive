import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "@golive/ui/components/button";
import { Input } from "@golive/ui/components/input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MonitorPlay, Radio } from "lucide-react";
import { useState } from "react";
export const Route = createFileRoute("/")({
    component: HomeComponent,
});
function HomeComponent() {
    const navigate = useNavigate();
    const [roomCode, setRoomCode] = useState("");
    const join = () => {
        const code = roomCode.trim().toLowerCase();
        if (code) {
            navigate({ to: "/watch/$code", params: { code } });
        }
    };
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-4xl flex-col items-center gap-10 px-4 py-12 md:px-6 md:py-16", children: [_jsxs("div", { className: "max-w-2xl text-center", children: [_jsxs("div", { className: "mb-4 inline-flex items-center gap-2 border border-foreground/15 bg-muted/40 px-3 py-1 text-xs font-medium", children: [_jsx("span", { className: "size-1.5 rounded-full bg-destructive animate-pulse" }), "invite-only \u00B7 free \u00B7 discord login"] }), _jsx("h1", { className: "text-4xl font-bold tracking-tight md:text-6xl", children: "GoLive" }), _jsx("p", { className: "mt-4 text-base text-muted-foreground md:text-lg", children: "Share your screen live \u2014 up to 1080p 60fps \u2014 with just a room code. No downloads, no accounts beyond Discord. Viewers land on the page and the stream just plays." })] }), _jsxs("div", { className: "grid w-full max-w-3xl gap-4 md:grid-cols-2", children: [_jsxs("div", { className: "flex flex-col gap-3 border border-foreground/10 bg-card p-5", children: [_jsxs("div", { className: "flex items-center gap-2 text-sm font-semibold", children: [_jsx(Radio, { className: "size-4 text-primary" }), "Start streaming"] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Create a room, pick a screen or window, and share the link." }), _jsxs(Button, { render: _jsx(Link, { to: "/live" }), nativeButton: false, className: "mt-2 w-full gap-2", children: [_jsx(Radio, { className: "size-4" }), "Go to studio"] })] }), _jsxs("div", { className: "flex flex-col gap-3 border border-foreground/10 bg-card p-5", children: [_jsxs("div", { className: "flex items-center gap-2 text-sm font-semibold", children: [_jsx(MonitorPlay, { className: "size-4 text-primary" }), "Watch a stream"] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Join a room by code. If no one is live yet, it starts automatically when they do." }), _jsxs("div", { className: "mt-2 flex gap-2", children: [_jsx(Input, { value: roomCode, onChange: (e) => setRoomCode(e.target.value), onKeyDown: (e) => {
                                            if (e.key === "Enter") {
                                                join();
                                            }
                                        }, placeholder: "Room code, e.g. 83jkf", autoCapitalize: "none", autoCorrect: "off", spellCheck: false }), _jsx(Button, { onClick: join, disabled: !roomCode.trim(), className: "shrink-0", children: "Join" })] })] })] })] }));
}
