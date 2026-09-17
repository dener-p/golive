import { createFileRoute } from "@tanstack/react-router";

import HelpContent from "@/components/help-content";

export const Route = createFileRoute("/ajuda")({
  component: RouteComponent,
});

function RouteComponent() {
  return <HelpContent />;
}