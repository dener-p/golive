import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Toaster } from "@golive/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import Header from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import "../index.css";
export const Route = createRootRouteWithContext()({
    component: RootComponent,
    head: () => ({
        meta: [
            {
                title: "golive",
            },
            {
                name: "description",
                content: "golive is a web application",
            },
        ],
        links: [
            {
                rel: "icon",
                type: "image/png",
                href: "/favicon.png",
            },
        ],
    }),
});
function RootComponent() {
    return (_jsxs(_Fragment, { children: [_jsx(HeadContent, {}), _jsxs(ThemeProvider, { attribute: "class", defaultTheme: "dark", disableTransitionOnChange: true, storageKey: "vite-ui-theme", children: [_jsxs("div", { className: "grid grid-rows-[auto_1fr] h-svh", children: [_jsx(Header, {}), _jsx(Outlet, {})] }), _jsx(Toaster, { richColors: true })] }), _jsx(TanStackRouterDevtools, { position: "bottom-left" })] }));
}
