import { jsx as _jsx } from "react/jsx-runtime";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
export const Route = createFileRoute("/_auth")({
    component: AuthLayout,
    beforeLoad: async () => {
        const session = await authClient.getSession();
        if (!session.data) {
            throw redirect({
                to: "/login",
                search: (prev) => ({
                    ...prev,
                    next: `${window.location.pathname}${window.location.search}`,
                }),
            });
        }
        return { session };
    },
});
function AuthLayout() {
    return _jsx(Outlet, {});
}
