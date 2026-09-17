import { jsx as _jsx } from "react/jsx-runtime";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultPendingComponent: () => _jsx(Loader, {}),
    context: {},
});
const rootElement = document.getElementById("app");
if (!rootElement) {
    throw new Error("Root element not found");
}
if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(_jsx(RouterProvider, { router: router }));
}
