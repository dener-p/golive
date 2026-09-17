import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Button } from "@golive/ui/components/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, } from "@golive/ui/components/card";
import { Input } from "@golive/ui/components/input";
import { Label } from "@golive/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Loader2, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ENV } from "@/env";
import { getTurnStatus } from "@/lib/turn-status";
import { createApiKey, deleteApiKey, revokeApiKey, } from "@/lib/turn-clients";
import { getIceServers } from "@/lib/turn";
export const Route = createFileRoute("/_auth/settings")({
    component: RouteComponent,
});
function StatusPill({ on, label, onLabel }) {
    return (_jsxs("span", { className: `inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-semibold ${on
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-muted/40 text-muted-foreground"}`, children: [on ? _jsx(Check, { className: "size-3" }) : _jsx(X, { className: "size-3" }), on ? onLabel : label] }));
}
function timeAgo(ts) {
    if (!ts) {
        return "never";
    }
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
}
function curlTemplate(key) {
    return `# push your TURN relay config (kept in memory until it expires)
curl -X POST ${ENV.VITE_SERVER_URL}/api/turn/webhook \\
  -H "X-Turn-Key: ${key.key.id}" \\
  -H "X-Turn-Timestamp: $(date +%s)" \\
  -H "X-Turn-Signature: $(echo -n $(date +%s) | openssl dgst -sha256 -hmac '${key.secret}' | awk '{print $2}')" \\
  -d '{"turn":"turn:myrelay.example.com:3478","user":"USERNAME","password":"PASSWORD","ttl":3600}'`;
}
function RouteComponent() {
    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState(null);
    const [name, setName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [created, setCreated] = useState(null);
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const load = useCallback(() => {
        setStatusError(null);
        getTurnStatus()
            .then(setStatus)
            .catch((error) => setStatusError(error.message));
    }, []);
    useEffect(() => {
        load();
    }, [load]);
    const copy = (text) => {
        navigator.clipboard.writeText(text).catch(() => { });
        toast("Copied");
    };
    const handleCreate = async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        setIsCreating(true);
        try {
            const key = await createApiKey(trimmed);
            setCreated(key);
            setName("");
            load();
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to create key");
        }
        finally {
            setIsCreating(false);
        }
    };
    const handleRevoke = async (id) => {
        try {
            await revokeApiKey(id);
            load();
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to revoke key");
        }
    };
    const handleDelete = async (id) => {
        if (!window.confirm("Delete this API key? It can no longer be used.")) {
            return;
        }
        try {
            await deleteApiKey(id);
            load();
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to delete key");
        }
    };
    const testConnection = async () => {
        setIsTesting(true);
        setTestResult(null);
        try {
            const servers = await getIceServers();
            const relays = servers.filter((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => url.startsWith("turn:")));
            const relayUrls = relays.flatMap((server) => Array.isArray(server.urls) ? server.urls : [server.urls]);
            setTestResult(relays.length > 0
                ? `${relayUrls.length} relay url${relayUrls.length === 1 ? "" : "s"} returned`
                : "No relay configured or it expired — clients will connect directly only");
        }
        catch (error) {
            setTestResult(`Test failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        finally {
            setIsTesting(false);
        }
    };
    const expiresIn = status?.relay ? status.relay.expiresAt - Date.now() : null;
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-bold tracking-tight", children: "Settings" }), _jsx("p", { className: "mt-1 text-sm text-muted-foreground", children: "Webhook API keys let you push your own TURN relay. Credentials stay in memory until they expire \u2014 nothing is persisted." })] }), statusError ? (_jsx("p", { className: "rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive", children: statusError })) : null, _jsxs("div", { className: "grid gap-4 md:grid-cols-2", children: [_jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-center gap-2", children: [_jsx("div", { className: "flex size-8 items-center justify-center bg-primary/10 text-primary", children: _jsx(Server, { className: "size-4" }) }), _jsx(CardTitle, { children: "Active TURN relay" }), _jsx(CardAction, { children: _jsxs(Button, { variant: "outline", size: "sm", onClick: load, className: "gap-1", children: [_jsx(RefreshCw, { className: "size-3" }), "Refresh"] }) })] }), _jsx(CardContent, { className: "flex flex-col gap-2", children: status?.relay ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "State" }), _jsx(StatusPill, { on: true, label: "Expired", onLabel: "Fresh" })] }), _jsx("div", { className: "flex flex-col gap-1", children: status.relay.urls.map((url) => (_jsx("code", { className: "truncate font-mono text-xs", children: url }, url))) }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Username" }), _jsx("span", { className: "font-mono", children: status.relay.username ?? "—" })] }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Pushed" }), _jsx("span", { children: timeAgo(status.relay.pushedAt) })] }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Expires" }), _jsx("span", { children: expiresIn != null && expiresIn > 0 ? `${Math.ceil(expiresIn / 1000)}s` : "now" })] }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Source key" }), _jsx("span", { children: status.relay.keyName })] })] })) : (_jsx("p", { className: "text-muted-foreground", children: "No relay config. Create a key and push your TURN server to get relayed connections." })) }), _jsx(CardFooter, { children: _jsxs(Button, { variant: "secondary", onClick: testConnection, disabled: isTesting, className: "w-full gap-1", children: [isTesting ? _jsx(Loader2, { className: "size-3.5 animate-spin" }) : _jsx(Check, { className: "size-3.5" }), "Test connection"] }) }), testResult ? (_jsx("p", { className: "border-t px-(--card-spacing) py-3 text-xs text-muted-foreground", children: testResult })) : null] }), _jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-center gap-2", children: [_jsx("div", { className: "flex size-8 items-center justify-center bg-primary/10 text-primary", children: _jsx(KeyRound, { className: "size-4" }) }), _jsx(CardTitle, { children: "Webhook API keys" })] }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "key-name", children: "New key" }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { id: "key-name", value: name, placeholder: "e.g. My coturn", onChange: (e) => setName(e.target.value), onKeyDown: (e) => {
                                                        if (e.key === "Enter") {
                                                            handleCreate();
                                                        }
                                                    } }), _jsx(Button, { onClick: handleCreate, disabled: isCreating || !name.trim(), className: "shrink-0", children: isCreating ? _jsx(Loader2, { className: "size-4 animate-spin" }) : "Create" })] })] }) }), status && status.keys.length > 0 ? (_jsx("ul", { className: "flex flex-col border-t", children: status.keys.map((key) => (_jsxs("li", { className: "flex items-center gap-2 px-(--card-spacing) py-3 text-xs", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: key.revokedAt ? "text-muted-foreground line-through" : "truncate font-medium", children: key.name }), _jsx("p", { className: "truncate font-mono text-muted-foreground", children: key.id }), _jsxs("p", { className: "text-muted-foreground", children: ["Created ", timeAgo(key.createdAt), " \u00B7 Used ", timeAgo(key.lastUsedAt)] })] }), key.revokedAt ? (_jsx("span", { className: "border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground", children: "Revoked" })) : (_jsx(Button, { variant: "outline", size: "sm", onClick: () => handleRevoke(key.id), children: "Revoke" })), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => handleDelete(key.id), children: _jsx(Trash2, { className: "size-3.5" }) })] }, key.id))) })) : null] })] }), created ? (_jsxs(Card, { className: "border-primary/50", children: [_jsxs(CardHeader, { className: "flex flex-row items-center gap-2", children: [_jsx("div", { className: "flex size-8 items-center justify-center bg-primary/10 text-primary", children: _jsx(KeyRound, { className: "size-4" }) }), _jsx(CardTitle, { children: "Key created \u2014 copy the secret now" })] }), _jsxs(CardContent, { className: "flex flex-col gap-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Key id (X-Turn-Key)" }), _jsxs("span", { className: "flex items-center gap-2", children: [_jsx("code", { className: "font-mono", children: created.key.id }), _jsxs(Button, { variant: "outline", size: "sm", onClick: () => copy(created.key.id), className: "gap-1", children: [_jsx(Copy, { className: "size-3" }), " Copy"] })] })] }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-muted-foreground", children: "Secret" }), _jsxs("span", { className: "flex items-center gap-2", children: [_jsx("code", { className: "font-mono", children: created.secret }), _jsxs(Button, { variant: "outline", size: "sm", onClick: () => copy(created.secret), className: "gap-1", children: [_jsx(Copy, { className: "size-3" }), " Copy"] })] })] }), _jsx("p", { className: "rounded border border-border bg-muted/40 p-2 text-xs text-muted-foreground", children: "This secret is shown once. With it you sign webhook requests (HMAC over the timestamp). If you lose it, revoke the key and create a new one." }), _jsx("pre", { className: "overflow-x-auto border p-3 font-mono text-[11px] leading-relaxed", children: curlTemplate(created) }), _jsxs(Button, { variant: "ghost", size: "sm", onClick: () => copy(curlTemplate(created)), className: "self-start gap-1", children: [_jsx(Copy, { className: "size-3" }), " Copy curl example"] })] })] })) : null] }));
}
