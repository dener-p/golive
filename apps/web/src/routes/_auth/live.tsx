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
    } catch (error) {
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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {session.data?.user.name}. Create a room to stream, or jump into one someone shared with
          you.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <Radio className="size-4" />
            </div>
            <CardTitle>Start a transmission</CardTitle>
          </CardHeader>
          <CardDescription>
            <div className="px-(--card-spacing) text-xs/relaxed text-muted-foreground">
              Create a room and you'll get a short code. Anyone with the link can watch — they just
              need a Discord account.
            </div>
          </CardDescription>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                placeholder="e.g. Weekend games"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleCreate} disabled={isCreating} className="w-full gap-2">
              <Radio className="size-4" />
              {isCreating ? "Creating…" : "Create room & open studio"}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <div className="flex size-8 items-center justify-center bg-primary/10 text-primary">
              <MonitorPlay className="size-4" />
            </div>
            <CardTitle>Watch a stream</CardTitle>
          </CardHeader>
          <CardDescription>
            <div className="px-(--card-spacing) text-xs/relaxed text-muted-foreground">
              Enter a room code. If no one is live yet, we'll stay in the room and the stream will
              start automatically.
            </div>
          </CardDescription>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="room-code">Room code</Label>
              <div className="flex gap-2">
                <Input
                  id="room-code"
                  value={roomCode}
                  placeholder="e.g. 83jkf"
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
                  Join
                </Button>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              Room codes are case-insensitive — no need to type the &ldquo;#&rdquo;.
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
