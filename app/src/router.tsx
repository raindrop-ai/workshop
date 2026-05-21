import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { NavSidebar } from "./components/NavSidebar";
import { MessagePane } from "./components/MessagePane";
import { CaseContextPanel } from "./components/CaseContextPanel";
import { DetectBenchPage } from "./pages/DetectBenchPage";
import { ExperimentResultsPage } from "./pages/ExperimentResultsPage";
import { RunsPage } from "./pages/RunsPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { SettingsPage } from "./pages/SettingsPage";
import { sendWorkshopMessage, useWorkshopConnected } from "./hooks/use-workshop-ws";
import { useAgentUiCommands } from "./hooks/use-agent-ui-commands";
import { runPath } from "./utils/navigation";

const DISCONNECTED_NOTICE_DELAY_MS = 100;

/** Redirect legacy `/#<runId>` links to `/runs/<runId>`. */
function LegacyHashRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash || hash.startsWith("wd-")) return;
    navigate(runPath(hash), { replace: true });
  }, [location.hash, navigate]);

  return null;
}

function AppLayout() {
  const [showDisconnectedNotice, setShowDisconnectedNotice] = useState(false);
  const runMatch = useMatch({ path: "/runs/:runId", end: false });
  const activeRunId = runMatch?.params.runId
    ? decodeURIComponent(runMatch.params.runId)
    : null;
  const location = useLocation();
  const showCaseContext = location.pathname.startsWith("/runs");
  const workshopConnected = useWorkshopConnected();
  useAgentUiCommands();

  useEffect(() => {
    if (workshopConnected) {
      setShowDisconnectedNotice(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowDisconnectedNotice(true);
    }, DISCONNECTED_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [workshopConnected]);

  useEffect(() => {
    sendWorkshopMessage({ type: "ui_view", run_id: activeRunId });
  }, [activeRunId]);

  return (
    <SidebarProvider defaultOpen={false}>
      <LegacyHashRedirect />
      <NavSidebar />
      <SidebarInset>
        <div className="relative h-screen overflow-hidden">
          <div
            className={`flex h-full transition-all duration-200 ${showDisconnectedNotice ? "pointer-events-none select-none blur-sm opacity-45" : ""}`}
            aria-hidden={showDisconnectedNotice}
          >
            <div className="flex-1 min-w-0 overflow-auto">
              <Outlet />
            </div>
            <MessagePane activeRunId={activeRunId} />
          </div>
          {showCaseContext && (
            <div className="absolute left-3 top-14 z-30 max-w-[calc(100vw-96px)]">
              <CaseContextPanel selectedRunId={activeRunId} floating />
            </div>
          )}
          {showDisconnectedNotice && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 px-6">
              <div
                className="flex min-h-[180px] w-[520px] max-w-full flex-col items-center justify-center rounded-[10px] border border-white/10 bg-zinc-950/90 px-9 py-6 text-center shadow-2xl shadow-black/50 backdrop-blur"
                style={{ fontFamily: '"AlphaLyrae", sans-serif' }}
              >
                <div className="text-lg font-medium text-white/90">Workshop isn&apos;t running.</div>
                <div className="mt-4 text-[15px] leading-relaxed text-white/62">
                  Run <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/90">raindrop workshop</code> from your terminal to resume.
                </div>
              </div>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/runs" replace /> },
      { path: "experiments", element: <ExperimentResultsPage /> },
      { path: "detectbench", element: <DetectBenchPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId/span/:spanId", element: <RunsPage /> },
      { path: "runs/:runId/spans", element: <RunsPage /> },
      { path: "runs/:runId/convo", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunsPage /> },
      { path: "search/:runId/span/:spanId", element: <SearchPage /> },
      { path: "search/:runId/spans", element: <SearchPage /> },
      { path: "search/:runId/convo", element: <SearchPage /> },
      { path: "search/:runId", element: <SearchPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "saved/:runId/span/:spanId", element: <SavedPage /> },
      { path: "saved/:runId/spans", element: <SavedPage /> },
      { path: "saved/:runId/convo", element: <SavedPage /> },
      { path: "saved/:runId", element: <SavedPage /> },
      { path: "saved", element: <SavedPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/runs" replace /> },
    ],
  },
]);
