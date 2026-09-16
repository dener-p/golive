import { createFileRoute } from "@tanstack/react-router";

import DiscordSignIn from "@/components/discord-sign-in";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  return <DiscordSignIn />;
}
