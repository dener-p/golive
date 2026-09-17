import { jsx as _jsx } from "react/jsx-runtime";
import { createFileRoute } from "@tanstack/react-router";
import DiscordSignIn from "@/components/discord-sign-in";
const validateSearch = (search) => {
    return {
        next: typeof search.next === "string" && search.next.startsWith("/") ? search.next : "/live",
    };
};
export const Route = createFileRoute("/login")({
    validateSearch,
    component: RouteComponent,
});
function RouteComponent() {
    const { next } = Route.useSearch();
    return _jsx(DiscordSignIn, { next: next });
}
