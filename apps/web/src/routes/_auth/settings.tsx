import { Button } from "@golive/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@golive/ui/components/card";
import { Input } from "@golive/ui/components/input";
import { Label } from "@golive/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Loader2, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ENV } from "@/env";
import { getTurnStatus, type TurnStatus } from "@/lib/turn-status";
import {
  createApiKey,
  deleteApiKey,
  revokeApiKey,
  type CreatedApiKey,
} from "@/lib/turn-clients";
import { getIceServers } from "@/lib/turn";

export const Route = createFileRoute("/_auth/settings")({
  component: RouteComponent,
});

function StatusPill({ on, label, onLabel }: { on: boolean; label: string; onLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-semibold ${
        on
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-muted/40 text-muted-foreground"
      }`}
    >
      {on ? <Check className="size-3" /> : <X className="size-3" />}
      {on ? onLabel : label}
    </span>
  );
}

function timeAgo(ts: number | null): string {
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

function curlTemplate(key: CreatedApiKey): string {
  return `# push your TURN relay config (kept in memory until it expires)
curl -X POST ${ENV.VITE_SERVER_URL}/api/turn/webhook \\
  -H "X-Turn-Key: ${key.key.id}" \\
  -H "X-Turn-Timestamp: $(date +%s)" \\
  -H "X-Turn-Signature: $(echo -n $(date +%s) | openssl dgst -sha256 -hmac '${key.secret}' | awk '{print $2}')" \\
  -d '{"turn":"turn:myrelay.example.com:3478","user":"USERNAME","password":"PASSWORD","ttl":3600}'`;
}

function RouteComponent() {
  const [status, setStatus] = useState<TurnStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatusError(null);
    getTurnStatus()
      .then(setStatus)
      .catch((error: Error) => setStatusError(error.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create key");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiKey(id);
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke key");
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this API key? It can no longer be used.")) {
      return;
    }
    try {
      await deleteApiKey(id);
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete key");
    }
  };

  const testConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const servers = await getIceServers();
      const relays = servers.filter((server) =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
          url.startsWith("turn:"),
        ),
      );
      const relayUrls = relays.flatMap((server) =>
        Array.isArray(server.urls) ? server.urls : [server.urls],
      );
      setTestResult(
        relays.length > 0
          ? `${relayUrls.length} relay url${relayUrls.length === 1 ? "" : "s"} returned`
          : "No relay configured or it expired — clients will connect directly only",
      );
    } catch (error) {
      setTestResult(`Test failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setIsTesting(false);
    }
  };

  const expiresIn = status?.relay ? status.relay.expiresAt - Date.now() : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Webhook API keys let you push your own TURN relay. Credentials stay in memory until they
          expire — nothing is persisted.
        </p>
      </div>

      {statusError ? (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {statusError}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <Server className="size-4" />
            </div>
            <CardTitle>Active TURN relay</CardTitle>
            <CardAction>
              <Button variant="outline" size="sm" onClick={load} className="gap-1">
                <RefreshCw className="size-3" />
                Refresh
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {status?.relay ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">State</span>
                  <StatusPill on label="Expired" onLabel="Fresh" />
                </div>
                <div className="flex flex-col gap-1">
                  {status.relay.urls.map((url) => (
                    <code key={url} className="truncate font-mono text-xs">
                      {url}
                    </code>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Username</span>
                  <span className="font-mono">{status.relay.username ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Pushed</span>
                  <span>{timeAgo(status.relay.pushedAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Expires</span>
                  <span>
                    {expiresIn != null && expiresIn > 0 ? `${Math.ceil(expiresIn / 1000)}s` : "now"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Source key</span>
                  <span>{status.relay.keyName}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                No relay config. Create a key and push your TURN server to get relayed connections.
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              variant="secondary"
              onClick={testConnection}
              disabled={isTesting}
              className="w-full gap-1"
            >
              {isTesting ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Test connection
            </Button>
          </CardFooter>
          {testResult ? (
            <p className="border-t px-(--card-spacing) py-3 text-xs text-muted-foreground">{testResult}</p>
          ) : null}
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <KeyRound className="size-4" />
            </div>
            <CardTitle>Webhook API keys</CardTitle>
          </CardHeader>

          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="key-name">New key</Label>
              <div className="flex gap-2">
                <Input
                  id="key-name"
                  value={name}
                  placeholder="e.g. My coturn"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleCreate();
                    }
                  }}
                />
                <Button onClick={handleCreate} disabled={isCreating || !name.trim()} className="shrink-0">
                  {isCreating ? <Loader2 className="size-4 animate-spin" /> : "Create"}
                </Button>
              </div>
            </div>
          </CardContent>

          {status && status.keys.length > 0 ? (
            <ul className="flex flex-col border-t">
              {status.keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center gap-2 px-(--card-spacing) py-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className={key.revokedAt ? "text-muted-foreground line-through" : "truncate font-medium"}>
                      {key.name}
                    </p>
                    <p className="truncate font-mono text-muted-foreground">{key.id}</p>
                    <p className="text-muted-foreground">
                      Created {timeAgo(key.createdAt)} · Used {timeAgo(key.lastUsedAt)}
                    </p>
                  </div>
                  {key.revokedAt ? (
                    <span className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      Revoked
                    </span>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => handleRevoke(key.id)}>
                      Revoke
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(key.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      {created ? (
        <Card className="border-primary/50">
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <KeyRound className="size-4" />
            </div>
            <CardTitle>Key created — copy the secret now</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Key id (X-Turn-Key)</span>
              <span className="flex items-center gap-2">
                <code className="font-mono">{created.key.id}</code>
                <Button variant="outline" size="sm" onClick={() => copy(created.key.id)} className="gap-1">
                  <Copy className="size-3" /> Copy
                </Button>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Secret</span>
              <span className="flex items-center gap-2">
                <code className="font-mono">{created.secret}</code>
                <Button variant="outline" size="sm" onClick={() => copy(created.secret)} className="gap-1">
                  <Copy className="size-3" /> Copy
                </Button>
              </span>
            </div>
            <p className="rounded border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
              This secret is shown once. With it you sign webhook requests (HMAC over the
              timestamp). If you lose it, revoke the key and create a new one.
            </p>
            <pre className="overflow-x-auto border p-3 font-mono text-[11px] leading-relaxed">
              {curlTemplate(created)}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copy(curlTemplate(created))}
              className="self-start gap-1"
            >
              <Copy className="size-3" /> Copy curl example
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}