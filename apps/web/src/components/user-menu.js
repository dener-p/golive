import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "@golive/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@golive/ui/components/dropdown-menu";
import { Skeleton } from "@golive/ui/components/skeleton";
import { Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
export default function UserMenu() {
    const navigate = useNavigate();
    const { data: session, isPending } = authClient.useSession();
    if (isPending) {
        return _jsx(Skeleton, { className: "h-9 w-24" });
    }
    if (!session) {
        return (_jsx(Link, { to: "/login", search: { next: "/live" }, children: _jsx(Button, { variant: "outline", children: "Sign In" }) }));
    }
    return (_jsxs(DropdownMenu, { children: [_jsxs(DropdownMenuTrigger, { render: _jsx(Button, { variant: "outline" }), children: [session.user.image ? (_jsx("img", { src: session.user.image, alt: session.user.name, className: "size-4 rounded-full" })) : null, session.user.name] }), _jsx(DropdownMenuContent, { className: "bg-card", children: _jsxs(DropdownMenuGroup, { children: [_jsx(DropdownMenuLabel, { children: "My Account" }), _jsx(DropdownMenuSeparator, {}), session.user.email ? _jsx(DropdownMenuItem, { children: session.user.email }) : null, _jsx(DropdownMenuItem, { onClick: () => {
                                navigate({ to: "/settings" });
                            }, children: "Settings" }), _jsx(DropdownMenuItem, { variant: "destructive", onClick: () => {
                                authClient.signOut({
                                    fetchOptions: {
                                        onSuccess: () => {
                                            navigate({
                                                to: "/",
                                            });
                                        },
                                    },
                                });
                            }, children: "Sign Out" })] }) })] }));
}
