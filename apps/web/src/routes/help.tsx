import { createFileRoute } from "@tanstack/react-router";

import HelpContent from "@/components/help-content";

export const Route = createFileRoute("/help")({
  component: RouteComponent,
});

function RouteComponent() {
  return <HelpContent />;
}