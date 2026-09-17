import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, } from "@golive/ui/components/card";
import { Button } from "@golive/ui/components/button";
import { Input } from "@golive/ui/components/input";
import { Label } from "@golive/ui/components/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MonitorPlay, Radio } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createTransmission } from "@/lib/transmissions";
export const Route = createFileRoute("/_auth/live")({
    component: RouteComponent,
});
function RouteComponent() {
    const { session } = Route.useRouteContext();
    const navigate = useNavigate();
    const [title, setTitle] = useState("");
    const [roomCode, setRoomCode] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const handleCreate = async () => {
        setIsCreating(true);
        try {
            const room = await createTransmission(title);
            navigate({
                to: "/stream/$code",
                params: { code: room.code },
            });
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to create transmission");
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
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-bold tracking-tight", children: "Welcome back" }), _jsxs("p", { className: "mt-1 text-sm text-muted-foreground", children: [session.data?.user.name, ". Create a room to stream, or jump into one someone shared with you."] })] }), _jsxs("div", { className: "grid gap-4 md:grid-cols-2", children: [_jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-center gap-2", children: [_jsx("div", { className: "flex size-8 items-center justify-center bg-primary/10 text-primary", children: _jsx(Radio, { className: "size-4" }) }), _jsx(CardTitle, { children: "Start a transmission" })] }), _jsx(CardDescription, { children: _jsx("div", { className: "px-(--card-spacing) text-xs/relaxed text-muted-foreground", children: "Create a room and you'll get a short code. Anyone with the link can watch \u2014 they just need a Discord account." }) }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "title", children: "Title" }), _jsx(Input, { id: "title", value: title, placeholder: "e.g. Weekend games", onChange: (e) => setTitle(e.target.value) })] }) }), _jsx(CardFooter, { children: _jsxs(Button, { onClick: handleCreate, disabled: isCreating, className: "w-full gap-2", children: [_jsx(Radio, { className: "size-4" }), isCreating ? "Creating…" : "Create room & open studio"] }) })] }), _jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-center gap-2", children: [_jsx("div", { className: "flex size-8 items-center justify-center bg-primary/10 text-primary", children: _jsx(MonitorPlay, { className: "size-4" }) }), _jsx(CardTitle, { children: "Watch a stream" })] }), _jsx(CardDescription, { children: _jsx("div", { className: "px-(--card-spacing) text-xs/relaxed text-muted-foreground", children: "Enter a room code. If no one is live yet, we'll stay in the room and the stream will start automatically." }) }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "room-code", children: "Room code" }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { id: "room-code", value: roomCode, placeholder: "e.g. 83jkf", autoCapitalize: "none", autoCorrect: "off", spellCheck: false, onChange: (e) => setRoomCode(e.target.value), onKeyDown: (e) => {
                                                        if (e.key === "Enter") {
                                                            handleJoin();
                                                        }
                                                    } }), _jsx(Button, { onClick: handleJoin, disabled: !roomCode.trim(), className: "shrink-0", children: "Join" })] })] }) }), _jsx(CardFooter, { children: _jsx("p", { className: "text-xs text-muted-foreground", children: "Room codes are case-insensitive \u2014 no need to type the \u201C#\u201D." }) })] })] })] }));
}
